import React, { useState, useCallback, useEffect } from 'react';
import { generateTopics, generateChapters } from './services/storyApi';
import { StoryTopic, Chapter } from './types';
import Button from './components/Button';
import HomeButton from './components/HomeButton';

type AppPage = 'input' | 'topics' | 'chapters';

function App() {
  const [page, setPage] = useState<AppPage>('input');
  const [inputPrompt, setInputPrompt] = useState<string>('');
  const [generatedTopics, setGeneratedTopics] = useState<StoryTopic[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<StoryTopic | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const goHome = useCallback(() => {
    setPage('input');
    setInputPrompt('');
    setGeneratedTopics([]);
    setSelectedTopic(null);
    setChapters([]);
    setErrorMessage(null);
    setIsLoading(false);
  }, []);

  const handleExampleClick = useCallback((examplePrompt: string) => {
    setInputPrompt(examplePrompt);
  }, []);

  const handleGenerateTopics = useCallback(async () => {
    if (!inputPrompt.trim()) {
      setErrorMessage('스토리 내용을 입력해주세요.');
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const topics = await generateTopics(inputPrompt);
      setGeneratedTopics(topics.map((text, index) => ({ id: String(index), text })));
      setPage('topics');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [inputPrompt]);

  const handleTopicSelect = useCallback((topic: StoryTopic) => {
    setSelectedTopic(topic);
    setPage('chapters'); // Immediately move to chapter generation page
  }, []);

  const handleGenerateChapters = useCallback(async () => {
    if (!selectedTopic) {
      setErrorMessage('선택된 주제가 없습니다.');
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    setChapters([]); // Clear previous chapters
    try {
      const generatedChapters = await generateChapters(selectedTopic.text);
      setChapters(generatedChapters);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedTopic]);

  // Automatically trigger chapter generation when selectedTopic is set and page is 'chapters'
  useEffect(() => {
    if (page === 'chapters' && selectedTopic && chapters.length === 0) {
      handleGenerateChapters();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, selectedTopic, handleGenerateChapters]);


  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('이미지 프롬프트가 클립보드에 복사되었습니다!');
    }).catch(err => {
      console.error('클립보드 복사 실패:', err);
      alert('클립보드 복사에 실패했습니다.');
    });
  }, []);

  return (
    <div className="relative max-w-4xl mx-auto bg-white rounded-xl shadow-lg border border-gray-100 p-6 sm:p-10 min-h-[calc(100vh-64px)] flex flex-col">
      <h1 className="text-3xl sm:text-4xl font-extrabold text-center text-purple-700 mb-8 mt-4 tracking-wide">
        제이린쌤 스토리 챕터 만들기
      </h1>

      {page !== 'input' && <HomeButton onClick={goHome} />}

      {errorMessage && (
        <div className="bg-red-50 border border-red-400 text-red-700 px-4 py-3 rounded-lg relative mb-6" role="alert">
          <span className="block sm:inline">{errorMessage}</span>
          <span className="absolute top-0 bottom-0 right-0 px-4 py-3">
            <svg onClick={() => setErrorMessage(null)} className="fill-current h-6 w-6 text-red-500 cursor-pointer" role="button" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>Close</title><path d="M14.348 14.849a1.2 1.2 0 0 1-1.697 0L10 11.819l-2.651 3.029a1.2 1.2 0 1 1-1.697-1.697l2.758-3.15-2.759-3.152a1.2 1.2 0 1 1 1.697-1.697L10 8.183l2.651-3.031a1.2 1.2 0 1 1 1.697 1.697l-2.758 3.152 2.758 3.15a1.2 1.2 0 0 1 0 1.698z"/></svg>
          </span>
        </div>
      )}

      {/* Page 1: Input and Topic Generation */}
      {page === 'input' && (
        <div className="flex flex-col items-center">
          <textarea
            className="w-full p-4 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-400 focus:border-purple-400 mb-6 text-gray-700 resize-y min-h-[150px] shadow-sm"
            placeholder="예시를 참고하여 스토리 내용을 입력해주세요. (예: 시바견이 의인화 된 직장인이야 재밌는 스토리를 30대 직장인 입장에서 만들어줘)"
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            rows={6}
          ></textarea>

          <div className="flex flex-wrap justify-center gap-3 mb-8 w-full">
            <button
              onClick={() => handleExampleClick('시바견이 의인화 된 직장인이야 재밌는 스토리를 30대 직장인 입장에서 만들어줘 일단 주제를 10개 만들어줘')}
              className="px-4 py-2 text-base font-semibold rounded-xl bg-purple-50 text-purple-700 hover:bg-purple-100 shadow-sm transition-all duration-200 transform hover:scale-105 min-h-[60px] flex items-center justify-center text-center"
            >
              예시 1: 시바견 직장인
            </button>
            <button
              onClick={() => handleExampleClick('고양이가 의인화된 20대 백수야 재밌는 스토리를 20대 백수 입장에서 만들어줘 일단 주제를 10개 만들어줘')}
              className="px-4 py-2 text-base font-semibold rounded-xl bg-purple-50 text-purple-700 hover:bg-purple-100 shadow-sm transition-all duration-200 transform hover:scale-105 min-h-[60px] flex items-center justify-center text-center"
            >
              예시 2: 고양이 백수
            </button>
            <button
              onClick={() => handleExampleClick('삐쩍마른 의인화된 고양이야 늘 비웃음만 당하다 열심히 운동을 해서 몸이 좋아지고 여자들이 쫒아다니게 하는 내용 구체적으로 주제 10개 만들어줘')}
              className="px-4 py-2 text-base font-semibold rounded-xl bg-purple-50 text-purple-700 hover:bg-purple-100 shadow-sm transition-all duration-200 transform hover:scale-105 min-h-[60px] flex items-center justify-center text-center"
            >
              예시 3: 근육 고양이
            </button>
          </div>

          <Button
            onClick={handleGenerateTopics}
            isLoading={isLoading}
            disabled={!inputPrompt.trim()}
            className="w-full sm:w-auto px-8 py-3"
          >
            {isLoading ? '주제 생성 중...' : '주제 생성'}
          </Button>
        </div>
      )}

      {/* Page 2: Display Generated Topics */}
      {page === 'topics' && (
        <div className="flex flex-col items-center flex-grow">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-6 text-center">
            생성된 스토리 주제 (10개)
          </h2>
          <p className="text-gray-600 mb-8 text-center">마음에 드는 주제를 선택해주세요.</p>
          {generatedTopics.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl">
              {generatedTopics.map((topic) => (
                <Button
                  key={topic.id}
                  onClick={() => handleTopicSelect(topic)}
                  variant="outline"
                  className="w-full text-left p-4 h-auto text-base hover:bg-purple-50 shadow-sm rounded-xl transform hover:scale-102 transition-all duration-200 min-h-[80px] flex items-center justify-center"
                >
                  {topic.text}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-gray-600">생성된 주제가 없습니다.</p>
          )}
        </div>
      )}

      {/* Page 3: Display Generated Chapters */}
      {page === 'chapters' && selectedTopic && (
        <div className="flex flex-col flex-grow">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-4 text-center">
            "{selectedTopic.text}" - 15챕터 스토리
          </h2>
          {isLoading && chapters.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-grow text-purple-600">
              <svg className="animate-spin h-10 w-10 mb-4 text-purple-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <p className="text-lg animate-pulse">챕터와 이미지 프롬프트 생성 중...</p>
              <p className="text-sm text-gray-500 mt-2">이 과정은 몇 분 정도 소요될 수 있습니다.</p>
            </div>
          ) : chapters.length > 0 ? (
            <div className="space-y-8 mt-6">
              {chapters.map((chapter) => (
                <div key={chapter.chapterNumber} className="bg-white p-6 rounded-xl shadow-lg border border-purple-100">
                  <h3 className="text-xl font-semibold text-purple-700 mb-2">
                    챕터 {chapter.chapterNumber}: {chapter.chapterTitle}
                  </h3>
                  <p className="text-gray-800 mb-4 leading-relaxed">{chapter.storySummary}</p>
                  <div className="bg-purple-50 p-4 rounded-lg border border-purple-200 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <p className="font-medium text-gray-700 sm:w-auto flex-shrink-0">이미지 프롬프트:</p>
                    <div className="flex-grow text-gray-900 text-sm overflow-auto max-h-32 sm:max-h-full">
                      {chapter.imagePrompt}
                    </div>
                    <Button
                      onClick={() => copyToClipboard(chapter.imagePrompt)}
                      variant="ghost"
                      size="sm"
                      className="whitespace-nowrap flex items-center gap-1 mt-2 sm:mt-0"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      복사
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600 text-center flex-grow flex items-center justify-center">
              생성된 챕터가 없습니다.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default App;