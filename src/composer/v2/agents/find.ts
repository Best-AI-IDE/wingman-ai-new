import { DynamicStructuredTool } from "@langchain/core/tools";
import { CodeGraph } from "../../../server/files/graph";
import { Store } from "../../../store/vector";
import { AIProvider } from "../../../service/base";
import { formatMessages, scanDirectory } from "../../utils";
import fs, { promises } from 'node:fs';
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatMessage } from "@langchain/core/messages";
import path from "node:path";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { FileMetadata } from "@shared/types/v2/Message";
import { PlanExecuteState } from "../types";
import { ProjectDetailsHandler } from "../../../server/project-details";
import { createReadFileTool } from "../tools/read_file";
import { semanticSearchTool } from "../tools/semantic_search";

export class PlannerAgent {
    private readonly tools: DynamicStructuredTool<any>[];
    private readonly model: BaseChatModel;
    private dependencies: Set<string> = new Set();
    private analyzedFiles: Map<string, FileMetadata> = new Map();
    private fileContentBuffer: string = '';

    constructor(
        private readonly aiProvider: AIProvider,
        private readonly codeGraph: CodeGraph,
        private readonly vectorStore: Store,
        private readonly workspace: string
    ) {
        this.tools = [
            createReadFileTool(this.workspace),
            semanticSearchTool(this.workspace, this.codeGraph, this.vectorStore)
        ];

        this.model = this.aiProvider.getReasoningModel({
            temperature: 0
        });
    }

    private processFileContent(text: string) {
        // Append new text to the buffer
        this.fileContentBuffer += text;

        // Process both sections
        this.processFilesInScope();
        this.processDependencies();

        return;
    }

    private processFilesInScope() {
        // Match the entire Required File Changes section, including optional whitespace
        const sectionRegex = /###\s*Required\s*File\s*Changes\s*\n([\s\S]*?)(?=###|$)/i;
        const sectionMatch = sectionRegex.exec(this.fileContentBuffer);

        if (sectionMatch) {
            const sectionContent = sectionMatch[1].trim();
            // Enhanced regex to handle multiple formats and edge cases
            const fileEntryRegex = /[-*•]\s*File:\s*[`'"]*([^`'"]+)[`'"]*\s*(?:\n|\r\n?|\s)*(?:[-*•])?\s*Analysis:\s*((?:(?!(?:[-*•]\s*File:|###)).)*)/gis;

            let match;
            const seenPaths = new Set<string>();

            while ((match = fileEntryRegex.exec(sectionContent)) !== null) {
                try {
                    const [, filePath = '', analysis = ''] = match;
                    const trimmedPath = filePath.trim();

                    // Skip empty or duplicate paths
                    if (!trimmedPath || seenPaths.has(trimmedPath)) {
                        continue;
                    }

                    seenPaths.add(trimmedPath);

                    this.analyzedFiles.set(trimmedPath, {
                        path: trimmedPath,
                        description: analysis.trim()
                            .replace(/\n+/g, ' ')  // Replace multiple newlines with space
                            .replace(/\s+/g, ' ')  // Normalize whitespace
                    });
                } catch (error) {
                    console.error('Error processing file entry:', error);
                    continue; // Skip problematic entries but continue processing
                }
            }

            // Remove the processed section from the buffer
            this.fileContentBuffer = this.fileContentBuffer.replace(sectionMatch[0], '').trim();
        }
    }

    private processDependencies() {
        const lines = this.fileContentBuffer.split('\n');
        let inDependenciesSection = false;
        const processedContent: string[] = [];

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine === '### New Dependencies') {
                inDependenciesSection = true;
                continue;
            }

            if (inDependenciesSection && trimmedLine.startsWith('###')) {
                inDependenciesSection = false;
            }

            if (inDependenciesSection && trimmedLine.startsWith('-')) {
                const cleaned = trimmedLine.replace(/^-\s*/, '');
                const packageMatch = cleaned.match(/^`?(@?[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?)`?/);

                if (packageMatch?.[1]) {
                    this.dependencies.add(packageMatch[1]);
                }
            }

            if (!inDependenciesSection) {
                processedContent.push(line);
            }
        }

        // Update buffer with remaining content
        this.fileContentBuffer = processedContent.join('\n');
    }

    invoke = async (state: PlanExecuteState) => {
        this.analyzedFiles.clear();
        this.dependencies.clear();
        this.fileContentBuffer = '';

        const contents = await scanDirectory(this.workspace, 12);
        const projectDetailsHandler = new ProjectDetailsHandler(this.workspace);
        const projectDetails = (await projectDetailsHandler.retrieveProjectDetails())?.description ?? "Not available.";

        const prompt = ChatPromptTemplate.fromMessages([
            ["system", `You are a seasoned full-stack software architect and technical lead.
Your task is to analyze the provided codebase and craft a concise, high-level, end-to-end implementation plan based on the user's request. Your response must be professional, succinct, and conversational.

To complete this task effectively, you have access to these tools:
- semantic_search_codebase: Use this to find relevant code files.
- read_file: Reads the exact contents of a specific file. Use this tool when you need to check: 1) dependency management files (package.json, pnpm-workspace.yaml, etc.), 2) configuration files, or 3) a specific file you already know the path to.

ALWAYS use these tools before making any recommendations. You must:
1. Search the codebase first using semantic_search_codebase.
2. Read important files using read_file.
3. Use read_file specifically to check dependency files (pnpm-workspace.yaml, package.json, requirements.txt) and analyze their contents.
4. Only after gathering information, provide your plan.
5. Ensure that if any new dependencies are suggested, they are verified against the contents of dependency management files read via read_file.
6. Before calling any tool, explain why you are doing so to the user.

**Project Details:**
${projectDetails}

**Core Rules:**
1. Do not repeat yourself or include code examples.
2. Do not mention tool names to the user.
3. Only call tools when necessary.
4. Before calling tools, explain why you are doing so.
5. Do not write any code or provide code examples.

**CRITICAL RESPONSE FORMAT - FOLLOW EXACTLY:**
[Brief acknowledgment of the user's request]

### Implementation Plan
[Numbered list of technical steps]

### Required File Changes
- File: \`[exact file path]\`
- Analysis: [single line description]

[Optional] ### New Dependencies
- [package-name]@[version]

**File Changes Format Rules:**
1. Each file entry MUST follow this exact format:
- File: \`path/to/file\`
- Analysis: [description]
2. No nested lists or sub-bullets.
3. No additional formatting.
4. Path must be in backticks.
5. Description must be on a single line.
6. No empty lines between entries.

**CRITICAL!!!**
Dependencies are critical, NEVER ASSUME A DEPENDENCY IS AVAILABLE - DO NOT SKIP THIS STEP. Use read_file on dependency management files (pnpm-workspace.yaml, package.json, requirements.txt) to verify existing dependencies before suggesting any new ones.

**Dependency Management Protocol:**
1. The "### New Dependencies" section MUST ONLY appear if new dependencies are actually needed.
2. Check dependency files in this order using read_file:
- pnpm-workspace.yaml
- package.json
- requirements.txt
3. For each potential new dependency:
- Verify it is not already present in the content obtained from these files.
- Only update the dependency version if it is absolutely vital; otherwise, use the existing one.
4. Never include an empty dependencies section.
5. Ensure all new dependency suggestions have been analyzed using read_file.

**IMPORTANT!**
Files that require modification or creation, especially those found via semantic_search_codebase, must be included in the "### Required File Changes" section.

**Integration Analysis Protocol:**
1. Component Integration:
- Route configurations
- Navigation components
- Layout structures
- State management
- Service integrations
- API endpoints
- Type definitions
- Test coverage

2. File Discovery:
- Search for related components.
- Identify parent components.
- Locate configuration files.
- Find affected test files.
- Check type definition files.

**File Analysis Format:**
- File: \`file path\`
- Analysis: [description of changes, not using a list format]

**Project Analysis Guidelines:**
1. Requirements Analysis
- Technical components breakdown.
- Core vs nice-to-have features.
- Component dependencies.
- Scalability requirements.
- Technical constraints.

2. Architecture Planning
- Design patterns.
- Component hierarchy.
- Shared services.
- Data flow.
- Error handling.
- Performance.
- Extensibility.

3. Implementation Strategy
- Implementation phases.
- Critical path.
- Testing strategy.
- Deployment needs.
- Success criteria.
- Maintenance plan.

4. Project Structure
- Folder organization.
- Module boundaries.
- Shared types.
- Configuration.
- Build pipeline.
- Naming conventions.
- Documentation.

5. Framework Considerations
- Best practices.
- Configurations.
- Routing.
- State management.
- Component composition.
- Data fetching.
- SSR/SSG needs.

6. Development Setup
- Dev tools.
- Local workflow.
- Debugging.
- Code quality.
- Hot reload.
- Environment configs.

7. Dependency Strategy
- Core dependencies.
- Version management.
- Peer dependencies.
- Package management.
- Monorepo structure.
- Update strategy.

**DO NOT SUGGEST A DEPENDENCY THE USER ALREADY HAS!**

File Selection Priority:
1. Active Context (Highest Priority)
    - Recently modified files matching the request
    - User provided files from the conversation
    - Files mentioned in the current implementation plan
    - These files are most likely to be relevant as they represent active work
    - These may not always be the best match, look for conversational shifts

2. Semantic Context (Medium Priority)
    - Files with matching functionality or purpose
    - Shared dependencies with active files
    - Files in similar component categories
    - Only consider if active context files don't fully solve the request

3. Workspace Search (Lower Priority)
    - Only search here if no matches found above
    - Look for files matching the technical requirements
    - Consider common patterns and structures

4. Detect Explicit File References
    - Identify key actionable phrases in the conversation, such as:
      - "Write tests for xyz"
      - "Create a new component based on xyz"
      - "Add implementation for xyz"
      - "Update xyz"
      - "Fix xyz"
      - "Modify xyz"
      - "Check xyz"
      - "Review xyz"
      - "Look at xyz"
      - "Show me xyz"
    - Use fuzzy matching to identify potential file references:
      - Match partial file names (e.g., "index" → "src/index.ts")
      - Match without extensions (e.g., "UserComponent" → "UserComponent.tsx")
      - Match basename only (e.g., "auth" → "src/services/auth.service.ts")
    - If there is a close match for a file under "Available workspace files":
      1. Compare the mentioned name against all available files
      2. Score matches based on:
         - Exact matches (highest priority)
         - Partial matches at the start of the filename
         - Partial matches anywhere in the filename
         - Matches without considering file extension
      3. Reference the best matching file
    - Add these files as targets with type "ANALYZE"
    - When multiple files match, include all relevant matches
    - Consider context to disambiguate similar file names

**CRITICAL RESPONSE RULES:**
- Follow the format exactly as it appears.
- Provide the File and Analysis on separate lines.
- File Analysis should be a single line with a description of the changes.
- Do not include a description or reason for New Dependencies, just the name (if any).
- Use GitHub markdown syntax to format the response elegantly.

**RESPONSE FORMAT:**
[Brief acknowledgment]

[Report tool progress with simple informational statements]

### Implementation Plan
[Ordered technical steps]

### Required File Changes
- File: \`file path\`
- Analysis: [description of changes, not using a list format]

[Only include the New Dependencies section if verified new ones are needed]

Would you like me to proceed with these changes?

----

**Files previously worked on/user provided (NOTE - Treat these with higher priority for matching or investigating first):**
${state.files?.map(f => `- ${f.path}`).join('\n')}

----

**Workspace Files:**
${contents.map(f => `- ${f.path}`).join('\n')}

CRITICAL REMINDERS:
- Follow format EXACTLY.
- File paths must be in backticks.
- Single-line descriptions only.
- No empty sections.
- Verify all dependencies using read_file before suggesting any new ones.
- Consider all integration points.
- Use proper markdown syntax.`],
            ["human", "{input}"],
            ["assistant", "I'll help analyze the codebase. Let me gather some information first."],
            ["placeholder", "{agent_scratchpad}"],
        ]);

        const agent = createToolCallingAgent({
            llm: this.model,
            tools: this.tools,
            prompt
        });

        const executor = new AgentExecutor({
            agent,
            tools: this.tools
        });

        let buffer = '';
        for await (const event of await executor.streamEvents(
            {
                input: `Use the following conversation, sorted oldest to newest to guide you in generating your plan.
Focus on the latest ask, but use the whole conversation as context, as I might be building on a previously created plan.
Use your best judgement around file selection and don't be too eager to choose files based on older/out of context asks.

Conversation:
${formatMessages(state.messages)}`
            },
            { version: "v2" }
        )) {
            switch (event.event) {
                case "on_chat_model_stream":
                    if (event.data.chunk?.content) {
                        if (Array.isArray(event.data.chunk.content)) {
                            const text = event.data.chunk.content[0]?.text || '';
                            buffer += text;
                        } else {
                            const text = event.data.chunk.content.toString() || '';
                            buffer += text;
                        }
                        await dispatchCustomEvent("composer-message-stream", buffer);
                    }
                    break;
            }
        }

        // Process the complete response once at the end
        this.processFileContent(buffer);

        const messages: ChatMessage[] = [...state.messages, new ChatMessage(buffer, "assistant")];

        await dispatchCustomEvent("composer-message-stream-finish", {
            messages
        });

        for (const [filePath, file] of this.analyzedFiles.entries()) {
            const sanitizedPath = filePath.replaceAll('`', '');

            const absolutePath = path.isAbsolute(sanitizedPath) ?
                sanitizedPath : path.join(this.workspace, sanitizedPath);

            file.path = sanitizedPath;

            if (fs.existsSync(absolutePath)) {
                file.code = (await promises.readFile(absolutePath)).toString();
            }
        }

        return {
            messages,
            files: Array.from(this.analyzedFiles.values()),
            projectDetails,
            dependencies: Array.from(this.dependencies),
            implementationPlan: buffer,
            error: undefined
        } satisfies Partial<PlanExecuteState>;
    }
}

export const createPlannerAgent = (
    aiProvider: AIProvider,
    codeGraph: CodeGraph,
    vectorStore: Store,
    workspace: string
) => {
    return new PlannerAgent(aiProvider, codeGraph, vectorStore, workspace);
};