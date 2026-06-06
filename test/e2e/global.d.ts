interface Window {
  __oblivionLoadCase?: (caseId: string, options?: { silent?: boolean }) => Promise<void>;
}