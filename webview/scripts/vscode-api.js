/**
 * VS Code Webview API Bridge
 * Handles communication between webview and extension host.
 */
const vscodeApi = (function() {
  // @ts-ignore — acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();

  /** Post a message to the extension host */
  function postMessage(message) {
    vscode.postMessage(message);
  }

  /** Set up listener for messages from extension host */
  function onMessage(handler) {
    window.addEventListener('message', (event) => {
      handler(event.data);
    });
  }

  /** Persist state in webview (survives panel hide/show) */
  function setState(state) {
    vscode.setState(state);
  }

  /** Get persisted state */
  function getState() {
    return vscode.getState();
  }

  return { postMessage, onMessage, setState, getState };
})();
