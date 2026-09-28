interface ChatModel { id: string; free?: boolean }
interface ChatProvider { id: string; available: boolean; chatModels: ChatModel[] }

export function eligibleChatProviders<T extends ChatProvider>(providers: T[], freeOnly: boolean): T[] {
  return providers.filter((provider) => provider.available).map((provider) => ({
    ...provider, chatModels: provider.chatModels.filter((model) => !freeOnly || model.free === true),
  })).filter((provider) => provider.chatModels.length > 0);
}

export function resolveChatSelection(providers: ChatProvider[], selected: string, freeOnly: boolean): string {
  if (!freeOnly) return selected;
  const eligible = eligibleChatProviders(providers, true);
  if (eligible.some((provider) => provider.chatModels.some((model) => `${provider.id}::${model.id}` === selected))) return selected;
  const first = eligible[0];
  return first ? `${first.id}::${first.chatModels[0].id}` : "";
}
