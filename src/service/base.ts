import type { AIModel } from "@shared/types/Models";
import type { Embeddings } from "@langchain/core/embeddings";
import type { LLM } from "@langchain/core/language_models/llms";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export type ModelParams = {
	temperature?: number;
	model?: string;
	streaming?: boolean;
	verbose?: boolean;
};

export interface AIProvider {
	codeModel: AIModel | undefined;
	validateSettings(): Promise<boolean>;
	codeComplete(
		beginning: string,
		ending: string,
		signal: AbortSignal,
		additionalContext?: string,
		recentClipboard?: string,
	): Promise<string>;
	getModel(params?: ModelParams): LLM | BaseChatModel;
	generateImage?(input: string): Promise<string | undefined>;
	getEmbedder(): Embeddings;
	getLightweightModel(): LLM | BaseChatModel;
}
