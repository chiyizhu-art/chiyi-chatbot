export const REQUIRED_CHAT_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt (optionally using an anchor image provided by the user).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt describing the image to generate.' },
        anchorImageBase64: {
          type: 'string',
          description:
            'Optional base64-encoded anchor image (no data URL prefix). Use it to guide/anchor generation.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot a metric vs release_date from the loaded YouTube channel JSON (labels are dates, values are numbers).',
    parameters: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description:
            'One of: view_count, like_count, comment_count, duration_seconds. This is plotted vs release_date.',
        },
      },
      required: ['metric'],
    },
  },
  {
    name: 'play_video',
    description:
      'Select a YouTube video from the loaded channel JSON and return its title/thumbnail/video URL.',
    parameters: {
      type: 'object',
      properties: {
        selection_type: {
          type: 'string',
          enum: ['title', 'ordinal', 'most_viewed'],
          description:
            'How to pick the video: fuzzy match title, 1-based ordinal index, or the most viewed video.',
        },
        value: {
          description:
            'If selection_type=title: string; ordinal: number (1-based); most_viewed: ignored (can be empty).',
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
      required: ['selection_type', 'value'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean/median/std/min/max for a metric in the loaded YouTube channel JSON.',
    parameters: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          description: 'One of: view_count, like_count, comment_count, duration_seconds.',
        },
      },
      required: ['metric'],
    },
  },
];

