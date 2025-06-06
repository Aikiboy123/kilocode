import { Anthropic } from "@anthropic-ai/sdk"
import { BetaThinkingConfigParam } from "@anthropic-ai/sdk/resources/beta"
import OpenAI from "openai"

import {
	ApiHandlerOptions,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	PROMPT_CACHING_MODELS,
	OPTIONAL_PROMPT_CACHING_MODELS,
} from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStreamChunk } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"

import { SingleCompletionHandler } from "../index"
import { DEFAULT_HEADERS, DEEP_SEEK_DEFAULT_TEMPERATURE } from "./constants"
import { getModelParams } from "../getModelParams"

import { BaseProvider } from "./base-provider"

const OPENROUTER_DEFAULT_PROVIDER_NAME = "[default]"

// Add custom interface for OpenRouter params.
type OpenRouterChatCompletionParams = OpenAI.Chat.ChatCompletionCreateParams & {
	transforms?: string[]
	include_reasoning?: boolean
	thinking?: BetaThinkingConfigParam
	// https://openrouter.ai/docs/use-cases/reasoning-tokens
	reasoning?: {
		effort?: "high" | "medium" | "low"
		max_tokens?: number
		exclude?: boolean
	}
}

// See `OpenAI.Chat.Completions.ChatCompletionChunk["usage"]`
// `CompletionsAPI.CompletionUsage`
// See also: https://openrouter.ai/docs/use-cases/usage-accounting
interface CompletionUsage {
	completion_tokens?: number
	completion_tokens_details?: {
		reasoning_tokens?: number
	}
	prompt_tokens?: number
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	total_tokens?: number
	cost?: number
}

export class OpenRouterHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const baseURL = this.options.openRouterBaseUrl || "https://openrouter.ai/api/v1"
		const apiKey = this.options.openRouterApiKey ?? "not-provided"

		this.client = new OpenAI({ baseURL, apiKey, defaultHeaders: DEFAULT_HEADERS })
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
	): AsyncGenerator<ApiStreamChunk> {
		let { id: modelId, maxTokens, thinking, temperature, topP, reasoningEffort, promptCache } = this.getModel()

		// Convert Anthropic messages to OpenAI format.
		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		// DeepSeek highly recommends using user instead of system role.
		if (modelId.startsWith("deepseek/deepseek-r1") || modelId === "perplexity/sonar-reasoning") {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		const isCacheAvailable = promptCache.supported && (!promptCache.optional || this.options.promptCachingEnabled)

		// Prompt caching: https://openrouter.ai/docs/prompt-caching
		// Now with Gemini support: https://openrouter.ai/docs/features/prompt-caching
		// Note that we don't check the `ModelInfo` object because it is cached
		// in the settings for OpenRouter and the value could be stale.
		if (isCacheAvailable) {
			openAiMessages[0] = {
				role: "system",
				// @ts-ignore-next-line
				content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
			}

			// Add cache_control to the last two user messages
			// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
			const lastTwoUserMessages = openAiMessages.filter((msg) => msg.role === "user").slice(-2)

			lastTwoUserMessages.forEach((msg) => {
				if (typeof msg.content === "string") {
					msg.content = [{ type: "text", text: msg.content }]
				}

				if (Array.isArray(msg.content)) {
					// NOTE: This is fine since env details will always be added
					// at the end. But if it wasn't there, and the user added a
					// image_url type message, it would pop a text part before
					// it and then move it after to the end.
					let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

					if (!lastTextPart) {
						lastTextPart = { type: "text", text: "..." }
						msg.content.push(lastTextPart)
					}

					// @ts-ignore-next-line
					lastTextPart["cache_control"] = { type: "ephemeral" }
				}
			})
		}

		// https://openrouter.ai/docs/transforms
		let fullResponseText = ""

		const completionParams: OpenRouterChatCompletionParams = {
			model: modelId,
			max_tokens: maxTokens,
			temperature,
			thinking, // OpenRouter is temporarily supporting this.
			top_p: topP,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			// Only include provider if openRouterSpecificProvider is not "[default]".
			...(this.options.openRouterSpecificProvider &&
				this.options.openRouterSpecificProvider !== OPENROUTER_DEFAULT_PROVIDER_NAME && {
					provider: { order: [this.options.openRouterSpecificProvider] },
				}),
			// This way, the transforms field will only be included in the parameters when openRouterUseMiddleOutTransform is true.
			...((this.options.openRouterUseMiddleOutTransform ?? true) && { transforms: ["middle-out"] }),
			...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
		}
		const stream = await this.client.chat.completions.create(completionParams)

		let lastUsage: CompletionUsage | undefined = undefined

		try {
			for await (const chunk of stream) {
				// OpenRouter returns an error object instead of the OpenAI SDK throwing an error.
				if ("error" in chunk) {
					const error = chunk.error as { message?: string; code?: number }
					console.error(`OpenRouter API Error: ${error?.code} - ${error?.message}`)
					throw new Error(`OpenRouter API Error ${error?.code}: ${error?.message}`)
				}

				const delta = chunk.choices[0]?.delta

				if ("reasoning" in delta && delta.reasoning && typeof delta.reasoning === "string") {
					yield { type: "reasoning", text: delta.reasoning }
				}

				if (delta?.content) {
					fullResponseText += delta.content
					yield { type: "text", text: delta.content }
				}

				if (chunk.usage) {
					lastUsage = chunk.usage
				}
			}
		} catch (error) {
			let errorMessage = makeOpenRouterErrorReadable(error)
			throw new Error(errorMessage)
		}

		if (lastUsage) {
			yield {
				type: "usage",
				inputTokens: lastUsage.prompt_tokens || 0,
				outputTokens: lastUsage.completion_tokens || 0,
				// Waiting on OpenRouter to figure out what this represents in the Gemini case
				// and how to best support it.
				// cacheReadTokens: lastUsage.prompt_tokens_details?.cached_tokens,
				reasoningTokens: lastUsage.completion_tokens_details?.reasoning_tokens,
				totalCost: lastUsage.cost || 0,
			}
		}
	}

	override getModel() {
		const modelId = this.options.openRouterModelId
		const modelInfo = this.options.openRouterModelInfo

		let id = modelId ?? openRouterDefaultModelId
		const info = modelInfo ?? openRouterDefaultModelInfo
		const isDeepSeekR1 = id.startsWith("deepseek/deepseek-r1") || modelId === "perplexity/sonar-reasoning"
		const defaultTemperature = isDeepSeekR1 ? DEEP_SEEK_DEFAULT_TEMPERATURE : 0
		const topP = isDeepSeekR1 ? 0.95 : undefined

		return {
			id,
			info,
			// maxTokens, thinking, temperature, reasoningEffort
			...getModelParams({ options: this.options, model: info, defaultTemperature }),
			topP,
			promptCache: {
				supported: PROMPT_CACHING_MODELS.has(id),
				optional: OPTIONAL_PROMPT_CACHING_MODELS.has(id),
			},
		}
	}

	async completePrompt(prompt: string) {
		let { id: modelId, maxTokens, thinking, temperature } = this.getModel()

		const completionParams: OpenRouterChatCompletionParams = {
			model: modelId,
			max_tokens: maxTokens,
			thinking,
			temperature,
			messages: [{ role: "user", content: prompt }],
			stream: false,
		}

		const response = await this.client.chat.completions.create(completionParams)

		if ("error" in response) {
			const error = response.error as { message?: string; code?: number }
			throw new Error(`OpenRouter API Error ${error?.code}: ${error?.message}`)
		}

		const completion = response as OpenAI.Chat.ChatCompletion
		return completion.choices[0]?.message?.content || ""
	}
}

// kilocode_change start
function makeOpenRouterErrorReadable(error: any) {
	if (error?.code === 429) {
		let retryAfter
		try {
			const parsedJson = JSON.parse(error.error.metadata?.raw)
			retryAfter = parsedJson?.error?.details.map((detail: any) => detail.retryDelay).filter((r: any) => r)[0]
		} catch (e) {}
		if (retryAfter) {
			return `Rate limit exceeded, try again in ${retryAfter}.`
		}
		return `Rate limit exceeded, try again later.\n${error?.message || error}`
	}
	return `OpenRouter API Error: ${error?.message || error}`
}
// kilocode_change end
