import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/** pi-ai `Models` with the OpenRouter provider (reads `OPENROUTER_API_KEY`). */
export const newModels = () => {
  const models = createModels();
  models.setProvider(openrouterProvider());
  return models;
};
