import { Chapter } from '../types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data as T;
}

// Calls the shared creator-studio server instead of GoogleGenAI directly, so
// the Gemini key never has to be baked into this app's build output.
export async function generateTopics(prompt: string): Promise<string[]> {
  try {
    const data = await postJson<{ topics: string[] }>('/api/story/topics', { prompt });
    return data.topics.slice(0, 10);
  } catch (error) {
    console.error('Error generating topics:', error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export async function generateChapters(topic: string): Promise<Chapter[]> {
  try {
    const data = await postJson<{ chapters: Chapter[] }>('/api/story/chapters', { topic });
    return data.chapters;
  } catch (error) {
    console.error('Error generating chapters:', error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
