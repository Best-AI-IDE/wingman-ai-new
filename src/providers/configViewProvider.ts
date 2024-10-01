import * as vscode from "vscode";
import fs from "node:fs";
import { AppMessage } from "@shared/types/Message";
import {
	ApiSettingsType,
	defaultInteractionSettings,
	InteractionSettings,
	OllamaEmbeddingSettingsType,
	OllamaSettingsType,
	OpenAIEmbeddingSettingsType,
	Settings,
} from "@shared/types/Settings";
import { loggingProvider } from "./loggingProvider";
import { eventEmitter } from "../events/eventEmitter";
import { addNoneAttributeToLink } from "./utilities";
import { SaveSettings } from "../service/settings";

export class ConfigViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "wingman.configview";
	private _view?: vscode.WebviewView;
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _settings: Settings
	) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext<unknown>,
		token: vscode.CancellationToken
	): void | Thenable<void> {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};
		webviewView.webview.html = this._getHtml(webviewView.webview);

		this._disposables.push(
			webviewView.webview.onDidReceiveMessage(
				async (data: AppMessage) => {
					if (!data) {
						return;
					}

					const { command, value } = data;

					switch (command) {
						case "init":
							const settings = await this.init(value);
							webviewView.webview.postMessage({
								command,
								value: settings,
							});
							break;
						case "saveSettings":
							SaveSettings(value as Settings);
							break;
					}
				}
			)
		);
	}

	private init = async (value: unknown): Promise<string> => {
		const settings = structuredClone(this._settings);

		try {
			const modelsResponse = await fetch(
				`${settings.providerSettings.Ollama?.baseUrl}/api/tags`
			);
			const modelsJson = (await modelsResponse.json()) as {
				models: { name: string }[];
			};
			const modelNames = modelsJson.models.map((m) => m.name);
			//@ts-expect-error
			settings["ollamaModels"] = modelNames;
		} catch (e) {
			//@ts-expect-error
			settings["ollamaModels"] = ["Failed to load."];
		}

		return JSON.stringify(settings);
	};

	private handleError(message: string) {
		vscode.window.showErrorMessage(message);
		loggingProvider.logError(message);
		eventEmitter._onFatalError.fire();
	}

	private log = (value: unknown) => {
		loggingProvider.logInfo(JSON.stringify(value ?? ""));
	};

	private _getHtml = (webview: vscode.Webview) => {
		const htmlUri = webview.asWebviewUri(
			vscode.Uri.joinPath(
				this._extensionUri,
				"out",
				"views",
				"config.html"
			)
		);

		const nonce = this.getNonce();

		const htmlContent = fs.readFileSync(htmlUri.fsPath, "utf8");

		// Replace placeholders in the HTML content
		const finalHtmlContent = htmlContent.replace(
			/CSP_NONCE_PLACEHOLDER/g,
			nonce
		);

		const prefix = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "out", "views")
		);
		const srcHrefRegex = /(src|href)="([^"]+)"/g;

		// Replace the matched filename with the prefixed filename
		const updatedHtmlContent = finalHtmlContent.replace(
			srcHrefRegex,
			(match, attribute, filename) => {
				const prefixedFilename = `${prefix}${filename}`;
				return `${attribute}="${prefixedFilename}"`;
			}
		);

		return addNoneAttributeToLink(updatedHtmlContent, nonce);
	};

	private getNonce = () => {
		let text = "";
		const possible =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(
				Math.floor(Math.random() * possible.length)
			);
		}
		return text;
	};

	dispose() {
		this._disposables.forEach((d) => d.dispose());
		this._disposables = [];
	}
}
