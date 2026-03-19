/**
 * Graph RAG Agent Factory
 * 
 * Creates a LangChain agent configured for code graph analysis.
 * Supports Azure OpenAI and Google Gemini providers.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createGraphRAGTools } from './tools';
import type { 
  ProviderConfig, 
  OpenAIConfig,
  AzureOpenAIConfig, 
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  AgentStreamChunk,
} from './types';
import { 
  type CodebaseContext,
  buildDynamicSystemPrompt,
  formatContextForPrompt,
} from './context-builder';

/** Extract plain text from message content (string, array of blocks, single object, or other formats) */
function extractTextFromContent(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let text = '';
    for (const b of c as any[]) {
      if (typeof b === 'string') text += b;
      else if (b?.type === 'text' && b?.text) text += b.text;
      else if (b?.text) text += b.text;
      else if (b?.type === 'content_block' && b?.text) text += b.text;
      else if (b?.type === 'input_text' && b?.text) text += b.text;
    }
    return text;
  }
  // Single object: { type: 'text', text: '...' } or { text: '...' }
  if (typeof c === 'object' && c !== null) {
    const o = c as any;
    if (o.text && typeof o.text === 'string') return o.text;
  }
  return '';
}

/**
 * System prompt for the Graph RAG agent
 * 
 * Design principles (based on Aider/Cline research):
 * - Short, punchy directives > long explanations
 * - No template-inducing examples
 * - Let LLM figure out HOW, just tell it WHAT behavior we want
 * - Explicit progress reporting requirement
 * - Anti-laziness directives
 */
/**
 * Base system prompt - exported so it can be used with dynamic context injection
 * 
 * Structure (optimized for instruction following):
 * 1. Identity + GROUNDING mandate (most important)
 * 2. Core protocol (how to work)
 * 3. Tools reference
 * 4. Output format & rules
 * 5. [Dynamic context appended at end]
 */
export const BASE_SYSTEM_PROMPT = `You are Nexus, a Code Analysis Agent with Knowledge Graph access. Ground every claim.

## RULES
- **Cite or retract.** Use [[file:line]] or [[Type:Name]]. No citation = say "I didn't find evidence."
- **Validate with cypher** before final output. Don't trust readme alone.
- **Read before concluding.** Don't guess from names.
- **impact output is trusted** — no re-validation needed.

## PROTOCOL
Search (cypher/search/grep) → Read → Trace → Cite → Validate.

## TOOLS
\`search\` hybrid | \`cypher\` graph (use {{QUERY_VECTOR}}) | \`grep\` regex | \`read\` file | \`explore\` symbol/cluster | \`overview\` map | \`impact\` blast radius

## GRAPH
Nodes: File, Function, Class, Method, Community, Process, Commit. Relations: CONTAINS, DEFINES, IMPORTS, CALLS, EXTENDS, IMPLEMENTS, HAS_METHOD, MEMBER_OF, STEP_IN_PROCESS. Node ID: \`Label:filePath:name\`.

Cypher: \`MATCH (f:File)-[:CodeRelation {type:'IMPORTS'}]->(g) RETURN f.name,g.name\`

## OUTPUT
Tables + mermaid. TL;DR at end. Mermaid: no special chars in labels; wrap spaces: A["My Label"].
`;
export const createChatModel = (config: ProviderConfig): BaseChatModel => {
  switch (config.provider) {
    case 'openai': {
      const openaiConfig = config as OpenAIConfig;
      
      if (!openaiConfig.apiKey || openaiConfig.apiKey.trim() === '') {
        throw new Error('OpenAI API key is required but was not provided');
      }
      
      return new ChatOpenAI({
        apiKey: openaiConfig.apiKey,
        modelName: openaiConfig.model,
        temperature: openaiConfig.temperature ?? 0.1,
        maxTokens: openaiConfig.maxTokens,
        configuration: {
          apiKey: openaiConfig.apiKey,
          ...(openaiConfig.baseUrl ? { baseURL: openaiConfig.baseUrl } : {}),
        },
        streaming: true,
      });
    }
    
    case 'azure-openai': {
      const azureConfig = config as AzureOpenAIConfig;
      return new AzureChatOpenAI({
        azureOpenAIApiKey: azureConfig.apiKey,
        azureOpenAIApiInstanceName: extractInstanceName(azureConfig.endpoint),
        azureOpenAIApiDeploymentName: azureConfig.deploymentName,
        azureOpenAIApiVersion: azureConfig.apiVersion ?? '2024-12-01-preview',
        // Note: gpt-5.2-chat only supports temperature=1 (default)
        streaming: true,
      });
    }
    
    case 'gemini': {
      const geminiConfig = config as GeminiConfig;
      return new ChatGoogleGenerativeAI({
        apiKey: geminiConfig.apiKey,
        model: geminiConfig.model,
        temperature: geminiConfig.temperature ?? 0.1,
        maxOutputTokens: geminiConfig.maxTokens,
        streaming: true,
      });
    }
    
    case 'anthropic': {
      const anthropicConfig = config as AnthropicConfig;
      return new ChatAnthropic({
        anthropicApiKey: anthropicConfig.apiKey,
        model: anthropicConfig.model,
        temperature: anthropicConfig.temperature ?? 0.1,
        maxTokens: anthropicConfig.maxTokens ?? 8192,
        streaming: true,
      });
    }
    
    case 'ollama': {
      const ollamaConfig = config as OllamaConfig;
      return new ChatOllama({
        baseUrl: ollamaConfig.baseUrl ?? 'http://localhost:11434',
        model: ollamaConfig.model,
        temperature: ollamaConfig.temperature ?? 0.1,
        streaming: true,
        // Allow longer responses (Ollama default is often 128-2048)
        numPredict: 30000,
        // Increase context window (Ollama default is only 2048!)
        // This is critical for agentic workflows with tool calls
        numCtx: 32768,
      });
    }
    
    case 'openrouter': {
      const openRouterConfig = config as OpenRouterConfig;
      
      // Debug logging
      if (import.meta.env.DEV) {
        console.log('🌐 OpenRouter config:', {
          hasApiKey: !!openRouterConfig.apiKey,
          apiKeyLength: openRouterConfig.apiKey?.length || 0,
          model: openRouterConfig.model,
          baseUrl: openRouterConfig.baseUrl,
        });
      }
      
      if (!openRouterConfig.apiKey || openRouterConfig.apiKey.trim() === '') {
        throw new Error('OpenRouter API key is required but was not provided');
      }
      
      return new ChatOpenAI({
        openAIApiKey: openRouterConfig.apiKey,
        apiKey: openRouterConfig.apiKey, // Fallback for some versions
        modelName: openRouterConfig.model,
        temperature: openRouterConfig.temperature ?? 0.1,
        maxTokens: openRouterConfig.maxTokens,
        configuration: {
          apiKey: openRouterConfig.apiKey, // Ensure client receives it
          baseURL: openRouterConfig.baseUrl ?? 'https://openrouter.ai/api/v1',
        },
        streaming: true,
      });
    }
    
    default:
      throw new Error(`Unsupported provider: ${(config as any).provider}`);
  }
};

/**
 * Extract instance name from Azure endpoint URL
 * e.g., "https://my-resource.openai.azure.com" -> "my-resource"
 */
const extractInstanceName = (endpoint: string): string => {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname;
    // Extract the first part before .openai.azure.com
    const match = hostname.match(/^([^.]+)\.openai\.azure\.com/);
    if (match) {
      return match[1];
    }
    // Fallback: just use the first part of hostname
    return hostname.split('.')[0];
  } catch {
    return endpoint;
  }
};

/**
 * Create a Graph RAG agent
 */
export const createGraphRAGAgent = (
  config: ProviderConfig,
  executeQuery: (cypher: string) => Promise<any[]>,
  semanticSearch: (query: string, k?: number, maxDistance?: number) => Promise<any[]>,
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>,
  hybridSearch: (query: string, k?: number) => Promise<any[]>,
  isEmbeddingReady: () => boolean,
  isBM25Ready: () => boolean,
  fileContents: Map<string, string>,
  codebaseContext?: CodebaseContext
) => {
  const model = createChatModel(config);
  const tools = createGraphRAGTools(
    executeQuery,
    semanticSearch,
    semanticSearchWithContext,
    hybridSearch,
    isEmbeddingReady,
    isBM25Ready,
    fileContents
  );
  
  // Use dynamic prompt if context is provided, otherwise use base prompt
  const systemPrompt = codebaseContext 
    ? buildDynamicSystemPrompt(BASE_SYSTEM_PROMPT, codebaseContext)
    : BASE_SYSTEM_PROMPT;
  
  // Log prompt summary (full prompt can be very long)
  if (DEV) {
    const ctxLen = codebaseContext ? formatContextForPrompt(codebaseContext).length : 0;
    console.log(`🤖 [agent] created | prompt: ${systemPrompt.length} chars | context: ${ctxLen} chars`);
  }
  
  const agent = createReactAgent({
    llm: model as any,
    tools: tools as any,
    messageModifier: new SystemMessage(systemPrompt) as any,
  });
  
  return agent;
};

/**
 * Message type for agent conversation
 */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Non-streaming agent response: uses invoke instead of stream.
 * Yields tool_call, tool_result, content in order from the parsed result.
 * Fixes providers (e.g. OpenRouter) that don't stream final response correctly.
 */
const DEV = import.meta.env.DEV;

export async function* streamAgentResponse(
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[]
): AsyncGenerator<AgentStreamChunk> {
  try {
    if (DEV) {
      const lastUser = messages.filter(m => m.role === 'user').pop();
      console.log(`💬 [invoke] start | messages: ${messages.length} | last: "${(lastUser?.content ?? '').slice(0, 80)}…"`);
    }
    const formattedMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const result = await agent.invoke(
      { messages: formattedMessages },
      { recursionLimit: 50 }
    );

    const allMessages = result?.messages ?? [];
    const initialCount = formattedMessages.length;

    for (let i = initialCount; i < allMessages.length; i++) {
      const msg = allMessages[i];
      const msgType = msg._getType?.() || msg.type || msg.constructor?.name || '';

      if (msgType === 'ai' || msgType === 'AIMessage') {
        const toolCalls = msg.tool_calls || [];
        for (const tc of toolCalls) {
          const toolId = tc.id || `tool-${Date.now()}-${i}`;
          let args: Record<string, unknown> = tc.args || {};
          if (Object.keys(args).length === 0 && typeof tc.function?.arguments === 'string') {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              if (parsed && typeof parsed === 'object') args = parsed;
            } catch { /* ignore */ }
            }
          if (DEV) console.log(`🔧 [llm] tool_call: ${tc.name || 'unknown'}`, Object.keys(args).length ? args : '(no args)');
          yield {
            type: 'tool_call',
            toolCall: {
              id: toolId,
              name: tc.name || tc.function?.name || 'unknown',
              args,
              status: 'running',
            },
          };
        }

        const content = extractTextFromContent(msg.content) || extractTextFromContent(msg.additional_kwargs?.content);
        if (content && !(msg.tool_calls?.length)) {
          if (DEV) console.log(`📝 [llm] final response: ${content.length} chars`);
          yield { type: 'content', content };
        }
      }

      if (msgType === 'tool' || msgType === 'ToolMessage') {
        const toolCallId = msg.tool_call_id || '';
        const resultStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (DEV) console.log(`🔧 [llm] tool_result: ${msg.name || 'tool'} → ${resultStr.length} chars`);
        yield {
          type: 'tool_result',
          toolCall: {
            id: toolCallId,
            name: msg.name || 'tool',
            args: {},
            result: resultStr,
            status: 'completed',
          },
        };
      }
    }

    yield { type: 'done' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (DEV) console.error('❌ Invoke error:', message, error);
    yield { type: 'error', error: message };
  }
}

/**
 * Get a non-streaming response from the agent
 * Simpler for cases where streaming isn't needed
 */
export const invokeAgent = async (
  agent: ReturnType<typeof createReactAgent>,
  messages: AgentMessage[]
): Promise<string> => {
  const formattedMessages = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));
  
  const result = await agent.invoke({ messages: formattedMessages });
  
  // result.messages is the full conversation state
  const lastMessage = result.messages[result.messages.length - 1];
  return lastMessage?.content?.toString() ?? 'No response generated.';
};

