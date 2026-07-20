
export interface StoryTopic {
  id: string;
  text: string;
}

export interface Chapter {
  chapterNumber: number;
  chapterTitle: string;
  storySummary: string;
  imagePrompt: string;
}

export interface GenerateChaptersResponse {
  chapters: Chapter[];
}