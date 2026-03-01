import { GoogleGenerativeAI } from '@google/generative-ai';
import { CSV_TOOL_DECLARATIONS } from './csvTools';

const genAI = new GoogleGenerativeAI(process.env.REACT_APP_GEMINI_API_KEY || '');

// NOTE: `gemini-2.0-flash` is no longer available to new users (404 from API).
// Use a currently supported Flash model instead.
const MODEL = 'gemini-2.5-flash';

const SEARCH_TOOL = { googleSearch: {} };
const CODE_EXEC_TOOL = { codeExecution: {} };

export const CODE_KEYWORDS = /\b(plot|chart|graph|analyz|statistic|regression|correlat|histogram|visualiz|calculat|compute|run code|write code|execute|pandas|numpy|matplotlib|csv|data)\b/i;

let cachedPrompt = null;

async function loadSystemPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try {
    const res = await fetch('/prompt_chat.txt');
    cachedPrompt = res.ok ? (await res.text()).trim() : '';
  } catch {
    cachedPrompt = '';
  }
  return cachedPrompt;
}

function buildPersonalizationInstruction(user) {
  if (!user || typeof user !== 'object') return '';
  const username = typeof user.username === 'string' ? user.username : '';
  const firstName = typeof user.firstName === 'string' ? user.firstName : '';
  const lastName = typeof user.lastName === 'string' ? user.lastName : '';

  const displayFirst = (firstName || username || 'there').trim();
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();

  return `CHAT PERSONALIZATION (required):
- The user is ${fullName ? fullName : username ? username : 'unknown'}.
- In the first assistant message of a NEW chat (no prior assistant messages), greet the user by FIRST NAME: "${displayFirst}".`;
}

// Yields:
//   { type: 'text', text }           — streaming text chunks
//   { type: 'fullResponse', parts }  — when code was executed; replaces streamed text
//   { type: 'grounding', data }      — Google Search metadata
//
// fullResponse parts: { type: 'text'|'code'|'result'|'image', ... }
//
// useCodeExecution: pass true to use codeExecution tool (CSV/analysis),
//                   false (default) to use googleSearch tool.
// Note: Gemini does not support both tools simultaneously.
export const streamChat = async function* (history, newMessage, imageParts = [], useCodeExecution = false, user = null) {
  const systemInstruction = await loadSystemPrompt();
  const personalization = buildPersonalizationInstruction(user);
  const tools = useCodeExecution ? [CODE_EXEC_TOOL] : [SEARCH_TOOL];
  const combinedInstruction = [systemInstruction, personalization].filter(Boolean).join('\n\n');
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools,
    ...(combinedInstruction ? { systemInstruction: combinedInstruction } : {}),
  });

  const baseHistory = history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chat = model.startChat({ history: baseHistory });

  const parts = [
    { text: newMessage },
    ...imageParts.map((img) => ({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    })),
  ].filter((p) => p.text !== undefined || p.inlineData !== undefined);

  const result = await chat.sendMessageStream(parts);

  // Stream text chunks for live display
  for await (const chunk of result.stream) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of chunkParts) {
      if (part.text) yield { type: 'text', text: part.text };
    }
  }

  // After stream: inspect all response parts
  const response = await result.response;
  const allParts = response.candidates?.[0]?.content?.parts || [];

  const hasCodeExecution = allParts.some(
    (p) =>
      p.executableCode ||
      p.codeExecutionResult ||
      (p.inlineData && p.inlineData.mimeType?.startsWith('image/'))
  );

  if (hasCodeExecution) {
    // Build ordered structured parts to replace the streamed text
    const structuredParts = allParts
      .map((p) => {
        if (p.text) return { type: 'text', text: p.text };
        if (p.executableCode)
          return {
            type: 'code',
            language: p.executableCode.language || 'PYTHON',
            code: p.executableCode.code,
          };
        if (p.codeExecutionResult)
          return {
            type: 'result',
            outcome: p.codeExecutionResult.outcome,
            output: p.codeExecutionResult.output,
          };
        if (p.inlineData)
          return { type: 'image', mimeType: p.inlineData.mimeType, data: p.inlineData.data };
        return null;
      })
      .filter(Boolean);

    yield { type: 'fullResponse', parts: structuredParts };
  }

  // Grounding metadata (search sources)
  const grounding = response.candidates?.[0]?.groundingMetadata;
  if (grounding) {
    console.log('[Search grounding]', grounding);
    yield { type: 'grounding', data: grounding };
  }
};

// ── Function-calling chat for CSV tools ───────────────────────────────────────
// Gemini picks a tool + args → executeFn runs it client-side (free) → Gemini
// receives the result and returns a natural-language answer.
//
// executeFn(toolName, args) → plain JS object with the result
// Returns the final text response from the model.

export const chatWithCsvTools = async (history, newMessage, csvHeaders, executeFn, user = null) => {
  const systemInstruction = await loadSystemPrompt();
  // Note: this path is used only when the CSV JS tools handle the request.
  // Keep the same personalization behavior as the streaming path.
  const personalization = buildPersonalizationInstruction(user);
  const combinedInstruction = [systemInstruction, personalization].filter(Boolean).join('\n\n');
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: CSV_TOOL_DECLARATIONS }],
    ...(combinedInstruction ? { systemInstruction: combinedInstruction } : {}),
  });

  const baseHistory = history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chat = model.startChat({ history: baseHistory });

  // Include column names so the model can match user intent to exact column names
  const msgWithContext = csvHeaders?.length
    ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}`
    : newMessage;

  let response = (await chat.sendMessage(msgWithContext)).response;

  // Accumulate chart payloads and a log of every tool call made
  const charts = [];
  const toolCalls = [];

  // Function-calling loop (Gemini may chain multiple tool calls)
  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    console.log('[CSV Tool]', name, args);
    const toolResult = executeFn(name, args);
    console.log('[CSV Tool result]', toolResult);

    // Log the call for persistence
    toolCalls.push({ name, args, result: toolResult });

    // Capture chart payloads so the UI can render them
    if (toolResult?._chartType) {
      charts.push(toolResult);
    }

    response = (
      await chat.sendMessage([
        { functionResponse: { name, response: { result: toolResult } } },
      ])
    ).response;
  }

  return { text: response.text(), charts, toolCalls };
};
