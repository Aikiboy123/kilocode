// npx jest src/api/providers/__tests__/openrouter.test.ts

import axios from "axios"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { OpenRouterHandler } from "../openrouter"
import { ApiHandlerOptions, ModelInfo } from "../../../shared/api"

// Mock dependencies
jest.mock("openai")
jest.mock("axios")
jest.mock("delay", () => jest.fn(() => Promise.resolve()))

const mockOpenRouterModelInfo: ModelInfo = {
	maxTokens: 1000,
	contextWindow: 2000,
	supportsPromptCache: false,
	inputPrice: 0.01,
	outputPrice: 0.02,
}

describe("OpenRouterHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		openRouterApiKey: "test-key",
		openRouterModelId: "test-model",
		openRouterModelInfo: mockOpenRouterModelInfo,
	}

	beforeEach(() => {
		jest.clearAllMocks()
	})

	it("initializes with correct options", () => {
		const handler = new OpenRouterHandler(mockOptions)
		expect(handler).toBeInstanceOf(OpenRouterHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: mockOptions.openRouterApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://kilocode.ai",
				"X-Title": "Kilo Code",
			},
		})
	})

	describe("getModel", () => {
		it("returns correct model info when options are provided", () => {
			const handler = new OpenRouterHandler(mockOptions)
			const result = handler.getModel()

			expect(result).toEqual({
				id: mockOptions.openRouterModelId,
				info: mockOptions.openRouterModelInfo,
				maxTokens: 1000,
				thinking: undefined,
				temperature: 0,
				reasoningEffort: undefined,
				topP: undefined,
				promptCache: {
					supported: false,
					optional: false,
				},
			})
		})

		it("returns default model info when options are not provided", () => {
			const handler = new OpenRouterHandler({})
			const result = handler.getModel()

			expect(result.id).toBe("anthropic/claude-3.7-sonnet")
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("honors custom maxTokens for thinking models", () => {
			const handler = new OpenRouterHandler({
				openRouterApiKey: "test-key",
				openRouterModelId: "test-model",
				openRouterModelInfo: {
					...mockOpenRouterModelInfo,
					maxTokens: 128_000,
					thinking: true,
				},
				modelMaxTokens: 32_768,
				modelMaxThinkingTokens: 16_384,
			})

			const result = handler.getModel()
			expect(result.maxTokens).toBe(32_768)
			expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 })
			expect(result.temperature).toBe(1.0)
		})

		it("does not honor custom maxTokens for non-thinking models", () => {
			const handler = new OpenRouterHandler({
				...mockOptions,
				modelMaxTokens: 32_768,
				modelMaxThinkingTokens: 16_384,
			})

			const result = handler.getModel()
			expect(result.maxTokens).toBe(1000)
			expect(result.thinking).toBeUndefined()
			expect(result.temperature).toBe(0)
		})
	})

	describe("createMessage", () => {
		it("generates correct stream chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
					yield {
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
					}
				},
			}

			// Mock OpenAI chat.completions.create
			const mockCreate = jest.fn().mockResolvedValue(mockStream)

			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const generator = handler.createMessage(systemPrompt, messages)
			const chunks = []

			for await (const chunk of generator) {
				chunks.push(chunk)
			}

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 0.001 })

			// Verify OpenAI client was called with correct parameters
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					model: mockOptions.openRouterModelId,
					temperature: 0,
					messages: expect.arrayContaining([
						{ role: "system", content: systemPrompt },
						{ role: "user", content: "test message" },
					]),
					stream: true,
				}),
			)
		})

		it("supports the middle-out transform", async () => {
			const handler = new OpenRouterHandler({
				...mockOptions,
				openRouterUseMiddleOutTransform: true,
			})
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
				},
			}

			const mockCreate = jest.fn().mockResolvedValue(mockStream)
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any
			;(axios.get as jest.Mock).mockResolvedValue({ data: { data: {} } })

			await handler.createMessage("test", []).next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ transforms: ["middle-out"] }))
		})

		it("adds cache control for supported models", async () => {
			const handler = new OpenRouterHandler({
				...mockOptions,
				openRouterModelInfo: {
					...mockOpenRouterModelInfo,
					supportsPromptCache: true,
				},
				openRouterModelId: "anthropic/claude-3.5-sonnet",
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
				},
			}

			const mockCreate = jest.fn().mockResolvedValue(mockStream)
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any
			;(axios.get as jest.Mock).mockResolvedValue({ data: { data: {} } })

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "message 1" },
				{ role: "assistant", content: "response 1" },
				{ role: "user", content: "message 2" },
			]

			await handler.createMessage("test system", messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: expect.arrayContaining([
								expect.objectContaining({ cache_control: { type: "ephemeral" } }),
							]),
						}),
					]),
				}),
			)
		})

		it("handles API errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { error: { message: "API Error", code: 500 } }
				},
			}

			const mockCreate = jest.fn().mockResolvedValue(mockStream)
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 500: API Error")
		})
	})

	describe("completePrompt", () => {
		it("returns correct response", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			const mockCreate = jest.fn().mockResolvedValue(mockResponse)
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith({
				model: mockOptions.openRouterModelId,
				max_tokens: 1000,
				thinking: undefined,
				temperature: 0,
				messages: [{ role: "user", content: "test prompt" }],
				stream: false,
			})
		})

		it("handles API errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "API Error",
					code: 500,
				},
			}

			const mockCreate = jest.fn().mockResolvedValue(mockError)
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("OpenRouter API Error 500: API Error")
		})

		it("handles unexpected errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = jest.fn().mockRejectedValue(new Error("Unexpected error"))
			;(OpenAI as jest.MockedClass<typeof OpenAI>).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")
		})
	})
})
