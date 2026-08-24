// Subset of vscode.proposed.chatProvider used for thinking-effort in the model picker.
// Copied from VS Code src/vscode-dts/vscode.proposed.chatProvider.d.ts.
//
// IMPORTANT: this file exists for TypeScript only. Do NOT add "chatProvider" to
// package.json `enabledApiProposals` — that would make the extension unpublishable
// on the Marketplace and Insiders-only. VS Code passes `configurationSchema` and
// `modelConfiguration` through without a proposal gate (see
// src/vs/workbench/api/common/extHostLanguageModels.ts), so the runtime works on
// stable VS Code. Only `requiresAuthorization`, `capabilities.editTools` and
// `isDefault` are actually gated — none of which we use.
//
// Can be removed once these members graduate into @types/vscode.

declare module 'vscode' {
	export interface ProvideLanguageModelChatResponseOptions {
		readonly modelConfiguration?: {
			readonly [key: string]: any;
		};
	}

	export interface LanguageModelChatInformation {
		readonly configurationSchema?: LanguageModelConfigurationSchema;
		readonly isUserSelectable?: boolean;
		readonly isBYOK?: boolean;
	}

	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			readonly [key: string]: Record<string, any> & {
				readonly enumItemLabels?: string[];
				readonly group?: string;
			};
		};
	};
}
