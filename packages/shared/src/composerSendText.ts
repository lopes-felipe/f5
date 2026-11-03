/** Sent in place of words when a message carries only images: providers need text to start a turn. */
export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

/** People sent only the images, so every surface that shows message text hides this prompt. */
export function isImageOnlyBootstrapPrompt(text: string): boolean {
  return text.trim() === IMAGE_ONLY_BOOTSTRAP_PROMPT;
}
