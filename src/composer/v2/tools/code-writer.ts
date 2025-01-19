import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PlanExecuteState } from "../types";
import { formatMessages, loadWingmanRules } from "../../utils";
import { NoFilesChangedError } from "../../errors";
import {
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { FileMetadata } from "@shared/types/Message";
import { getTextDocumentFromPath } from "../../../server/files/utils";
import path from "node:path";
import { GitCommandEngine } from "../../../utils/gitCommandEngine";
import { createPatch } from 'diff';
import fs from "node:fs";
import { Command } from "@langchain/langgraph";

type CodeResponse = {
	file: {
		description: string;
		path: string;
		code: string;
		markdownLanguage: string;
		diff?: string;
		dependencies?: string[];
	};
};

type BuildPromptParams = {
	projectDetails: string;
	request: string;
	modifiedFiles: string;
	availableFiles: string;
	rulePack?: string;
};

const DELIMITERS = {
	FILE_START: '===FILE_START===',
	FILE_END: '===FILE_END==='
} as const;

const FILE_SEPARATOR = "<FILE_SEPARATOR>";

class StreamParser {
	private buffer = '';
	private currentSection: 'file' | null = null;
	private gitCommands: GitCommandEngine | undefined;
	private result: CodeResponse = {
		file: {
			path: '',
			code: '',
			markdownLanguage: '',
			description: '',
		}
	};

	constructor(private readonly workspace: string) {
		this.gitCommands = new GitCommandEngine(process.cwd());
	}

	private isInSection(delimiter: string) {
		return this.buffer.includes(delimiter);
	}

	private generateDiffFromModifiedCode(newCode: string, filePath: string): string {
		try {
			if (!filePath) {
				throw new Error('File path is required');
			}

			if (typeof newCode !== 'string') {
				throw new Error('New code must be a string');
			}

			// Read existing file contents with error handling
			let fileContents = '';
			if (fs.existsSync(filePath)) {
				try {
					fileContents = fs.readFileSync(filePath, { encoding: 'utf-8' });
				} catch (e) {
					console.warn(`Failed to read file ${filePath}:`, e);
					// Continue with empty string for new files
				}
			}

			const patch = createPatch(
				filePath,
				fileContents,
				newCode,
				'',
				'',
				{ context: 3 }  // Optional: control context lines
			);

			const stats = {
				additions: 0,
				deletions: 0
			};

			// Safer line parsing
			const lines = patch.split('\n');
			for (const line of lines) {
				// Skip diff headers and metadata
				if (line.startsWith('+++') ||
					line.startsWith('---') ||
					line.startsWith('Index:') ||
					line.startsWith('===') ||
					line.startsWith('@@') ||
					line.startsWith('\\')) {
					continue;
				}

				if (line.startsWith('+')) {
					stats.additions++;
				} else if (line.startsWith('-')) {
					stats.deletions++;
				}
			}

			return `+${stats.additions},-${stats.deletions}`;
		} catch (error) {
			console.error('Error generating diff:', error);
			return '+0,-0'; // Safe fallback
		}
	}

	async parse(chunk: string): Promise<Partial<CodeResponse>> {
		this.buffer += chunk;

		// Determine current section
		if (this.isInSection(DELIMITERS.FILE_START)) {
			this.currentSection = 'file';
		}

		const updates: Partial<CodeResponse> = {};

		switch (this.currentSection) {
			case 'file':
				if (this.isInSection(DELIMITERS.FILE_END)) {
					const fileContent = this.buffer.substring(
						this.buffer.indexOf(DELIMITERS.FILE_START) + DELIMITERS.FILE_START.length,
						this.buffer.indexOf(DELIMITERS.FILE_END)
					);

					const pathMatch = fileContent.match(/Path: (.*?)(?:\n|$)/);
					const langMatch = fileContent.match(/Language: (.*?)(?:\n|$)/);
					const descMatch = fileContent.match(/Description: (.*?)(?:\n|$)/);
					const codeMatch = fileContent.match(/Code:\s*\n([\s\S]*$)/);
					const depsMatch = fileContent.match(/Dependencies: (.*?)(?:\n|$)/);

					const fileUpdate: CodeResponse['file'] = {
						path: pathMatch?.[1].trim() || '',
						markdownLanguage: langMatch?.[1].trim() || '',
						description: descMatch?.[1].trim() || '',
						code: codeMatch?.[1].trim() || '',
						dependencies: depsMatch?.[1]?.split(',').map(d => d.trim()) || []
					};

					if (fileUpdate.code && !fileUpdate.diff) {
						try {
							const filePath = path.isAbsolute(fileUpdate.path)
								? fileUpdate.path
								: path.join(this.workspace, fileUpdate.path);

							fileUpdate.diff = this.generateDiffFromModifiedCode(fileUpdate.code, filePath);
						} catch (e) {
							console.error('Unable to generate diff for:', fileUpdate.path, e);
						}
					}

					updates.file = fileUpdate;
					this.result.file = fileUpdate;
				}
				break;
		}

		return updates;
	}

	getResult(): CodeResponse {
		return this.result;
	}
}

const codeWriterPrompt = `You are a senior full-stack developer with exceptional technical expertise, focused on writing clean, maintainable code for AI-powered development tools.

STRICT OUTPUT FORMAT REQUIREMENTS:

Output Format:
===FILE_START===
Path: [Full file path]
Language: [Programming language]
Description: [One line description of changes]
Dependencies: [List of new dependencies if any, omit if none]
Code: 
[Complete file code]
===FILE_END===

VALIDATION RULES:
1. Each file block MUST contain exactly 5 fields: Path, Language, Description, Dependencies, and Code
2. Path MUST be the full file path
3. Language MUST be specified
4. Description MUST be one line only
5. Dependencies MUST list new dependencies or state "No new dependencies"
6. Code MUST be complete and functional
7. No explanatory text outside the defined sections
8. No additional formatting or sections allowed
9. All field values mentioned above in the file block are in a string format.

Core Principles:
1. Write simple, maintainable code - less code equals debt
2. Focus on readability over optimization
3. Ensure code correctness and reliability
4. Maintain existing patterns and conventions
5. Make minimal, focused changes
6. Do not remove existing code unless it is required to complete your change, do not break things.

File Handling:
1. Process one file at a time
2. Only modify/create files relevant to objective
3. Use provided file paths as reference
4. Omit irrelevant or unchanged files
5. Provide full, functional code responses
6. Always include complete file paths
7. List only files with actual changes
8. Write the best possible code
9. Ensure human readability
10. Preserve existing code structure

Implementation Guidelines:

1. Code Structure
   - Use early returns to reduce nesting
   - Order functions logically
   - Maintain consistent formatting
   - Follow established naming conventions
   - Use TypeScript features appropriately
   - Focus strictly on files in scope
   - Ensure relative file references
   - Preserve existing structure/comments

2. Best Practices
   - Write self-documenting code
   - Handle errors appropriately
   - Consider edge cases
   - Follow security best practices
   - Use meaningful names
   - Document complex logic
   - Follow DRY principles
   - Optimize for maintainability

3. Integration Requirements
   - Work within existing dependencies
   - Maintain file structure conventions
   - Handle imports/exports properly
   - Preserve functionality
   - Prevent regression bugs
   - Consider integration points
   - Ensure seamless component integration

4. Documentation
   - Document complex logic
   - Use JSDoc when appropriate
   - Add TODO comments for known issues
   - Maintain existing comments
   - Update documentation as needed
   - Keep comments focused and minimal

5. Quality Constraints
   - Write testable code
   - Consider performance implications
   - Use immutable patterns where appropriate
   - Maintain type safety
   - Handle edge cases
   - Follow security best practices
   - Use proper error handling/logging

{{rulepack}}

------

Project details:
{{details}}

------

Previous conversation and latest request:
{{request}}

------

Files available to create or modify:
{{availableFiles}}

{{modified}}

------

Remember:
- Follow the strict output format
- Only modify task-related code
- Preserve existing structure
- Focus on core objective
- Write maintainable code
- Handle edge cases
- Integrate seamlessly
- Optimize for maintainability
- Make minimal necessary changes`;

const buildPrompt = ({
	projectDetails,
	request,
	modifiedFiles,
	availableFiles,
	rulePack,
}: BuildPromptParams) => {
	const rulePromptAddition = !rulePack
		? ""
		: `Use the following rules to guide your code writing:
  
${rulePack}`;

	return codeWriterPrompt
		.replace("{{rulepack}}", rulePromptAddition)
		.replace("{{details}}", projectDetails)
		.replace("{{request}}", request)
		.replace("{{modified}}", modifiedFiles)
		.replace("{{availableFiles}}", availableFiles);
};

export class CodeWriter {
	private readonly _chatModel: BaseChatModel;
	constructor(
		chatModel: BaseChatModel,
		private readonly rerankModel: BaseChatModel,
		private readonly workspace: string
	) {
		//@ts-expect-error
		this._chatModel = chatModel.withConfig({
			timeout: 120000
		}).withRetry({
			stopAfterAttempt: 2
		})
	}

	codeWriterStep = async (state: PlanExecuteState) => {
		const rulePack = await loadWingmanRules(this.workspace);
		const request = formatMessages(state.messages);
		const files: FileMetadata[] = [];
		const allDependencies = new Set<string>();

		// Process files first
		for (let { path: file, code } of state.files || [{ path: "BLANK", changes: [], code: "" }]) {
			if (!code) {
				const textDocument = await getTextDocumentFromPath(path.join(this.workspace, file));
				code = textDocument?.getText();
			}

			const systemMessage = new SystemMessage({
				content: [
					{
						type: "text",
						cache_control: { type: "ephemeral" },
						text: buildPrompt({
							projectDetails: state.projectDetails || "Not available.",
							request,
							modifiedFiles: files.length === 0 ? "" :
								`Files already processed:\n${files.map(f =>
									`File: ${f.path}\nChanges: ${f.description}`
								).join('\n')}`,
							availableFiles: state.files
								?.filter((f) => f.path !== file)
								?.map((f) => `${FILE_SEPARATOR}\nFile: ${f.path}\nCode:\n${f.code}`)
								.join(`\n\n${FILE_SEPARATOR}\n\n`) || "",
							rulePack,
						}),
					},
				],
			});

			const parser = new StreamParser(this.workspace);

			let output = '';
			for await (const chunk of await this._chatModel.stream([
				systemMessage,
				new HumanMessage({
					content: [
						{
							type: "text",
							text: `Current file:\n${file === "BLANK"
								? `No related files found. Working directory:\n${this.workspace}`
								: `File:\n${file}\n\nCode (blank if must be created):\n${code}`}`,
						},
					],
				})
			])) {
				output += chunk.content.toString();
				const updates = await parser.parse(chunk.content.toString());

				if (updates.file) {
					if (!updates.file.code) {
						await dispatchCustomEvent("composer-error", {
							error:
								`I was unable to generate code for the following file: ${updates.file.path}, please try again.`,
						});
						return new Command({
							goto: "find",
						})
					}

					const stateFile = state?.files?.find(f => f.path === updates.file?.path);
					if (stateFile && !files.some(f => f.path === updates.file?.path)) {
						Object.assign(stateFile, updates.file);

						// Collect dependencies
						updates.file.dependencies?.forEach(dep => allDependencies.add(dep));

						files.push(stateFile);
						await dispatchCustomEvent('composer-files', { files: state.files });
					}
				}
			}
		}

		if (files.length === 0) {
			await dispatchCustomEvent("composer-error", {
				error:
					"I've failed to generate any code changes for this session, if this continues please clear the chat and try again.",
			});
			console.error("No files have been changed.");
			return new Command({
				goto: "find",
			})
		}

		return {
			files
		} satisfies Partial<PlanExecuteState>;
	}
}