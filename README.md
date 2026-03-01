# Chat App

A React chatbot with Gemini AI, web search, user auth, MongoDB persistence, and client-side data analysis. Glassmorphism UI with streaming responses, CSV upload, and code execution.

## How It Works

- **Frontend (React)** – Login/create account, chat UI with streaming, drag-and-drop CSV/images, Recharts bar charts
- **Backend (Express)** – REST API for users and sessions, connects to MongoDB
- **AI (Gemini)** – Streaming chat, Google Search grounding, Python code execution, and function calling for client-side tools
- **Storage (MongoDB)** – Users and chat sessions stored in `chatapp` database

## API Keys & Environment Variables

Create a `.env` file in the project root with:

| Variable | Required | Where used | Description |
|----------|----------|------------|-------------|
| `REACT_APP_GEMINI_API_KEY` | Yes | Frontend (baked in at build) | Google Gemini API key. Get one at [Google AI Studio](https://aistudio.google.com/apikey). |
| `REACT_APP_MONGODB_URI` | Yes | Backend | MongoDB Atlas connection string. Format: `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/` |
| `REACT_APP_API_URL` | Production only | Frontend (baked in at build) | Full URL of the backend, e.g. `https://your-backend.onrender.com`. Leave blank for local dev (proxy handles it). |

The backend also accepts `MONGODB_URI` or `REACT_APP_MONGO_URI` as the MongoDB connection string if you prefer those names.

### Example `.env` (local development)

```
REACT_APP_GEMINI_API_KEY=AIzaSy...
REACT_APP_MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/
# REACT_APP_API_URL not needed locally — the dev server proxies /api to localhost:3001
```

## MongoDB Setup

1. Create a [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) account and cluster.
2. Get your connection string (Database → Connect → Drivers).
3. Put it in `.env` as `REACT_APP_MONGODB_URI`.

All collections are created automatically on first use.

### Database: `chatapp`

#### Collection: `users`

One document per registered user.

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto-generated |
| `username` | string | Lowercase username |
| `password` | string | bcrypt hash |
| `email` | string | Email address (optional) |
| `createdAt` | string | ISO timestamp |

#### Collection: `sessions`

One document per chat conversation.

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto-generated — used as `session_id` |
| `username` | string | Owner of this chat |
| `agent` | string | AI persona (e.g. `"lisa"`) |
| `title` | string | Auto-generated name, e.g. `"Chat · Feb 18, 2:34 PM"` |
| `createdAt` | string | ISO timestamp |
| `messages` | array | Ordered list of messages (see below) |

Each item in `messages`:

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | `"user"` or `"model"` |
| `content` | string | Message text (plain, no CSV base64) |
| `timestamp` | string | ISO timestamp |
| `imageData` | array | *(optional)* Base64 image attachments `[{ data, mimeType }]` |
| `toolCalls` | array | *(optional)* Client-side tool invocations `[{ name, args, result }]` |

## Deploying to Render

The repo includes a `render.yaml` Blueprint that configures both the backend (Web Service) and frontend (Static Site) in one file.

### Step-by-step

**1. Deploy the backend first**

Go to [render.com](https://render.com) → New → **Web Service** → connect your GitHub repo.

| Setting | Value |
|---------|-------|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `node server/index.js` |

Add this environment variable in the Render dashboard:

| Variable | Value |
|----------|-------|
| `MONGODB_URI` | Your MongoDB Atlas connection string |

Once deployed, copy the backend URL (e.g. `https://chatapp-backend.onrender.com`).

---

**2. Deploy the frontend**

New → **Static Site** → same repo.

| Setting | Value |
|---------|-------|
| Build Command | `npm install && npm run build` |
| Publish Directory | `build` |

Add these environment variables:

| Variable | Value |
|----------|-------|
| `REACT_APP_GEMINI_API_KEY` | Your Gemini API key |
| `REACT_APP_API_URL` | Backend URL from step 1, e.g. `https://chatapp-backend.onrender.com` |

> **Important:** `REACT_APP_*` variables are baked into the JavaScript bundle at build time. If you change them in the dashboard, you must trigger a new deploy of the static site.

---

**Or use the Blueprint (both services at once)**

New → **Blueprint** → connect your repo. Render reads `render.yaml` and creates both services. You'll be prompted to enter the four secrets (`MONGODB_URI`, `REACT_APP_GEMINI_API_KEY`, `REACT_APP_API_URL`) after creation.

> **Note:** Because `REACT_APP_API_URL` must point to the backend's URL, which is only known after the backend is deployed, you may need to set `REACT_APP_API_URL` and re-deploy the static site after the first Blueprint run.

---

### Free tier cold starts

Render's free plan spins down services after 15 minutes of inactivity. The first request after a sleep takes ~30 seconds. Upgrade to the Starter plan ($7/mo) to avoid this.

---

## Running the App

### Option 1: Both together (single terminal)

```bash
npm install
npm start
```

> **Note:** `npm install` installs all required packages automatically. See [Dependencies](#dependencies) below for the full list.

### Option 2: Separate terminals (recommended for development)

First, install dependencies once:

```bash
npm install
```

Then open two terminals in the project root:

**Terminal 1 — Backend:**
```bash
npm run server
```

**Terminal 2 — Frontend:**
```bash
npm run client
```

This starts:

- **Backend** – http://localhost:3001  
- **Frontend** – http://localhost:3000  

Use the app at **http://localhost:3000**. The React dev server proxies `/api` requests to the backend.

### Verify Backend

- http://localhost:3001 – Server status page  
- http://localhost:3001/api/status – JSON with `usersCount` and `sessionsCount`

## Dependencies

All packages are installed via `npm install`. Key dependencies:

### Frontend

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | UI framework |
| `react-scripts` | Create React App build tooling |
| `@google/generative-ai` | Gemini API client (chat, function calling, code execution, search grounding) |
| `react-markdown` | Render markdown in AI responses |
| `remark-gfm` | GitHub-flavored markdown (tables, strikethrough, etc.) |
| `recharts` | Interactive charts (available for future visualizations) |

### Backend

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and REST API |
| `mongodb` | MongoDB driver for Node.js |
| `bcryptjs` | Password hashing |
| `cors` | Cross-origin request headers |
| `dotenv` | Load `.env` variables |

### Dev / Tooling

| Package | Purpose |
|---------|---------|
| `concurrently` | Run frontend and backend with a single `npm start` |

---

## Features

- **Create account / Login** – Username + password, hashed with bcrypt
- **Session-based chat history** – Each conversation is a separate session; sidebar lists all chats with delete option
- **Streaming Gemini responses** – Text streams in real time with animated "..." while thinking; Stop button to cancel
- **Google Search grounding** – Answers include cited web sources for factual queries
- **Python code execution** – Gemini writes and runs Python for plots, regression, histogram, scatter, and any analysis the JS tools can't handle
- **CSV upload** – Drag-and-drop or click to attach a CSV; a slim version of the data (key columns as plain text) plus a full statistical summary are sent to Gemini automatically
- **YouTube Channel Download tab** – After login, download metadata for up to 100 recent channel videos (title, description, duration, published date, view/like/comment counts, video URL, thumbnail URL, transcript if available) as a JSON file
- **Auto-computed engagement column** – When a CSV has `Favorite Count` and `View Count` columns, an `engagement` ratio (Favorite Count / View Count) is added automatically to every row
- **Client-side data analysis tools** – Fast, zero-cost function-calling tools that run in the browser. Gemini calls these automatically for data questions; results are saved to MongoDB alongside the message:
  - `compute_column_stats(column)` – mean, median, std, min, max, count for any numeric column
  - `get_value_counts(column, top_n)` – frequency count of each unique value in a categorical column
  - `get_top_tweets(sort_column, n, ascending)` – top or bottom N tweets sorted by any metric (including `engagement`), with tweet text and key metrics
- **Tool routing logic** – The app automatically routes requests: client-side JS tools for simple stats, Python code execution for plots and complex models, Google Search for factual queries
- **Markdown rendering** – AI responses render headers, lists, code blocks, tables, and links
- **Image support** – Attach images via drag-and-drop, the 📎 button, or paste from clipboard (Ctrl+V)

## YouTube Channel Download (HW5 Part 2)

After login, open the **“YouTube Channel Download”** tab in the sidebar.

- **Inputs**: channel URL (supports `https://www.youtube.com/@handle`, `/channel/CHANNEL_ID`, `/c/customname`) and max videos (default 10, max 100)
- **Progress**: shows a progress bar as each video finishes downloading
- **Output**: click **Download JSON** to save the results locally

### Notes

- **No YouTube API key required**: the backend uses `yt-dlp` server-side to fetch metadata reliably and avoid browser CORS issues.
- **Transcripts are best-effort**: if a transcript isn’t available for a video, `transcript` is `null` and the download continues.

### Sample output for grading

- `public/veritasium_channel_10.json` contains a 10-video sample for `https://www.youtube.com/@veritasium`.

## Chat System Prompt

The AI’s system instructions are loaded from **`public/prompt_chat.txt`**. Edit this file to change the assistant’s behavior (tone, role, format, etc.). Changes take effect on the next message; no rebuild needed.

### How to Get a Good Persona Prompt (Make the AI Sound Like Someone)

To make the AI sound like a specific person (celebrity, character, or role), ask your AI assistant or prompt engineer to do the following:

1. **Pull a bio** – “Look up [person’s name] on Wikipedia and summarize their background, career, and key facts.”

2. **Find speech examples** – “Search for interviews [person] has done and pull direct quotes that show how they talk—phrases they use, tone, vocabulary.”

3. **Describe the vibe** – “What’s their personality? Confident, shy, funny, formal? List 3–5 traits.”

4. **Define the role** – “This person is my assistant for [context, e.g. a Yale SOM course on Generative AI]. They should help with [specific tasks] while staying in character.”

5. **Ask for the full prompt** – “Write a system prompt for `prompt_chat.txt` that includes: (a) a short bio, (b) speech examples and phrases to mimic, (c) personality traits, and (d) their role as my assistant for [your use case].”

**Example request you can paste into ChatGPT/Claude/etc.:**

> Write a system prompt for a chatbot. The AI should sound like [Person X]. Pull their Wikipedia page and 2–3 interviews. Include: (1) a brief bio, (2) 5–8 direct quotes showing how they speak, (3) personality traits, and (4) their role as my teaching assistant for [Course Name] taught by [Professor] at [School]. Put it all in a format I can paste into `prompt_chat.txt`.
