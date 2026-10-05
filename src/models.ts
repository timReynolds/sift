import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { modelRef } from './contracts.ts';
import type { Profile } from './profiles.ts';

/** Providers resolve runner environment credentials in memory; Sift never serializes them. */
export async function runnerModels(profiles: Map<string, Profile>, signal?: AbortSignal) {
  const models = createModels();
  for (const provider of [
    anthropicProvider(),
    openaiProvider(),
    googleProvider(),
    openrouterProvider(),
  ]) {
    models.setProvider(provider);
  }
  const providers = [
    ...new Set([...profiles.values()].map((profile) => modelRef(profile.model).provider)),
  ];
  const refresh = await models.refresh({
    providers,
    signal,
  });
  for (const [provider, error] of refresh.errors) {
    throw new Error(`Model catalogue refresh for ${provider} failed: ${error.message}`);
  }
  for (const profile of profiles.values()) {
    const { provider, modelId } = modelRef(profile.model);
    if (!models.getProvider(provider)) {
      throw new Error(
        `Unsupported provider ${provider}; supported: anthropic, openai, google, openrouter`,
      );
    }
    const model = models.getModel(provider, modelId);
    if (!model) {
      throw new Error(`Unknown model ${profile.model} in the pinned Pi catalogue`);
    }
    if (!getSupportedThinkingLevels(model).includes(profile.reasoning)) {
      throw new Error(
        `Model ${profile.model} does not support reasoning level ${profile.reasoning}`,
      );
    }
  }
  return models;
}
