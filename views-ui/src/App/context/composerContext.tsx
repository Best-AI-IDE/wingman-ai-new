import { type ComposerResponse, type FileDiagnostic, type FileSearchResult, type ComposerThread, type ComposerState, type ComposerThreadEvent, AssistantMessage, ToolMessage } from "@shared/types/Composer";
import type { AppMessage } from "@shared/types/Message";
import type { RenameThreadEvent } from '@shared/types/Events';
import type React from "react";
import { createContext, type FC, type PropsWithChildren, useContext, useEffect, useRef, useState } from "react"
import { vscode } from "../utilities/vscode";
import type { AppState } from "@shared/types/Settings";

interface ComposerContextType {
  composerStates: ComposerState[];
  setComposerStates: React.Dispatch<React.SetStateAction<ComposerState[]>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  clearActiveMessage: () => void;
  setActiveComposerState: React.Dispatch<React.SetStateAction<ComposerState | undefined>>;
  activeComposerState: ComposerState | undefined;
  activeFiles: FileSearchResult[];
  setActiveFiles: React.Dispatch<React.SetStateAction<FileSearchResult[]>>;
  threads: ComposerThread[];
  activeThread: ComposerThread | null;
  fileDiagnostics: FileDiagnostic[];
  createThread: (title: string) => ComposerThread;
  switchThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, newTitle: string) => void;
  branchThread: (threadId: string) => void;
}

const ComposerContext = createContext<ComposerContextType | undefined>(undefined);

export const useComposerContext = () => {
  const context = useContext(ComposerContext);
  if (!context) throw new Error("useComposerContext must be used within ComposerProvider");
  return context;
};

export const ComposerProvider: FC<PropsWithChildren> = ({ children }) => {
  const [composerStates, setComposerStates] = useState<ComposerState[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [activeComposerState, setActiveComposerState] = useState<ComposerState | undefined>();
  const [chips, setChips] = useState<FileSearchResult[]>([]);
  const [fileDiagnostics, setFileDiagnostics] = useState<FileDiagnostic[]>([]);

  // Thread management state
  const [threads, setThreads] = useState<ComposerThread[]>([]);
  const [activeThread, setActiveThread] = useState<ComposerThread | null>(null);

  const activeThreadRef = useRef<ComposerThread | null>(null);

  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    window.addEventListener("message", handleResponse);
    return () => {
      window.removeEventListener("message", handleResponse);
    };
  }, []);

  useEffect(() => {
    if (composerStates.length === 0 && !activeComposerState) {
      setLoading(false);
    }
  }, [composerStates, activeComposerState]);

  const createThread = (title: string) => {
    const timestamp = Date.now();
    const newThread: ComposerThread = {
      id: crypto.randomUUID(),
      title,
      createdAt: timestamp,
    };

    setThreads(prevThreads => [...prevThreads, newThread]);
    setActiveThread(newThread);
    activeThreadRef.current = newThread;

    vscode.postMessage({
      command: "create-thread",
      value: newThread
    });

    return newThread;
  };

  const switchThread = (threadId: string) => {
    const thread = threads.find(t => t.id === threadId);
    if (thread) {
      setActiveThread(thread);
      activeThreadRef.current = thread;

      // Notify extension about thread switch
      vscode.postMessage({
        command: "switch-thread",
        value: threadId
      });
    }
  };

  const deleteThread = (threadId: string) => {
    // // Don't delete if it's the only thread
    if (threads.length <= 1) {
      return;
    }

    setThreads(prevThreads => {
      const updatedThreads = prevThreads.filter(t => t.id !== threadId);

      // If we're deleting the active thread, switch to another one
      if (activeThread?.id === threadId && updatedThreads.length > 0 && composerStates.length > 0) {
        const newActiveThread = updatedThreads[0];
        setActiveThread(newActiveThread);
        activeThreadRef.current = newActiveThread;
        setActiveComposerState(composerStates[0]);
      }

      return updatedThreads;
    });

    // Notify extension about thread deletion
    vscode.postMessage({
      command: "delete-thread",
      value: threadId
    });
  };

  const branchThread = (threadId: string) => {
    const originalThread = threads.find(t => t.id === threadId);
    if (!originalThread) return;

    const timestamp = Date.now();
    const newThread: ComposerThread = {
      id: crypto.randomUUID(),
      title: `Branch: ${originalThread.title}`,
      createdAt: timestamp,
      parentThreadId: originalThread.id
    };

    setThreads(prevThreads => [...prevThreads, newThread]);
    setActiveThread(newThread);
    activeThreadRef.current = newThread;
    vscode.postMessage({
      command: "branch-thread",
      value: newThread
    });
  }

  const renameThread = (threadId: string, newTitle: string) => {
    setThreads(prevThreads => {
      return prevThreads.map(thread => {
        if (thread.id === threadId) {
          const updatedThread = {
            ...thread,
            title: newTitle,
            updatedAt: Date.now()
          };

          // Update active thread if it's the one being renamed
          if (activeThread?.id === threadId) {
            setActiveThread(updatedThread);
            activeThreadRef.current = updatedThread;
          }

          return updatedThread;
        }
        return thread;
      });
    });

    // Notify extension about thread rename
    vscode.postMessage({
      command: "rename-thread",
      value: { threadId, title: newTitle } satisfies RenameThreadEvent
    });
  };

  const handleComposerEvent = (value: ComposerResponse) => {
    const { event, state } = value;

    //console.log(event, state);

    switch (event) {
      case "composer-message": {
        setLoading(true);

        if (activeThreadRef.current?.id === state.threadId) {
          setActiveComposerState(prev => {
            if (!prev) return prev;
            return reconcileMessages(prev, state);
          });
        }

        setComposerStates(states => {
          const stateIndex = states.findIndex(s => s.threadId === state.threadId);

          if (stateIndex === -1) return [...states];

          const updatedStates = [...states];
          updatedStates[stateIndex] = reconcileMessages(updatedStates[stateIndex], state)

          return updatedStates
        });

        break;
      }
      case "composer-error": {
        if (activeThreadRef.current?.id === state.threadId) {
          setActiveComposerState(prev => {
            if (!prev) return prev;
            return reconcileMessages(prev, state);
          });
        }

        setComposerStates(states => {
          const stateIndex = states.findIndex(s => s.threadId === state.threadId);

          if (stateIndex === -1) return [...states];

          const updatedStates = [...states];
          updatedStates[stateIndex] = reconcileMessages(updatedStates[stateIndex], state)

          return updatedStates
        });

        setLoading(false);
        break;
      }
      case "composer-done": {
        setComposerStates(states => {
          const stateIndex = states.findIndex(s => s.threadId === state.threadId);

          if (stateIndex === -1) return [...states];

          const updatedStates = [...states];

          if (stateIndex === -1) {
            updatedStates.push(state);
          } else {
            updatedStates[stateIndex] = state;
          }

          return updatedStates;
        });

        setLoading(false);
        break;
      }
    }
  };

  const handleResponse = (event: MessageEvent<AppMessage>) => {
    const { data } = event;
    const { command, value } = data;

    switch (command) {
      case "init": {
        const { threads, activeThreadId } = value as AppState;

        if (!threads) return;

        const stateThreads = threads.map(state => ({
          id: state.threadId,
          title: state.title,
          createdAt: state.createdAt,
          parentThreadId: state.parentThreadId
        } satisfies ComposerThread));

        setThreads(stateThreads);
        setComposerStates(threads);

        if (activeThreadId) {
          activeThreadRef.current = stateThreads.find(t => t.id === activeThreadId) ?? null;
          setActiveThread(activeThreadRef.current)
          setActiveComposerState(threads.find(t => t.threadId === activeThreadId));
        }
        break;
      }
      case "compose-response":
        handleComposerEvent(value as ComposerResponse);
        break;
      case "thread-data": {
        const { state, activeThreadId } = value as ComposerThreadEvent;

        if (!state) return;

        const composerThread: ComposerThread = {
          id: state.threadId,
          title: state.title,
          createdAt: state.createdAt,
          parentThreadId: state.parentThreadId
        };

        setThreads(threads => {
          const threadIndex = threads.findIndex(t => t.id === state.threadId);
          threads[threadIndex] = composerThread
          return [...threads];
        })

        setComposerStates(states => {
          const stateIndex = states.findIndex(t => t.threadId === state.threadId);
          states[stateIndex] = state;
          return [...states];
        });

        if (!activeComposerState || (activeComposerState && activeComposerState.threadId === activeThreadRef.current?.id)) {
          setActiveComposerState(state);
          activeThreadRef.current = composerThread;
          setActiveThread(composerThread)
        }

        break;
      }
      case "diagnostics": {
        setFileDiagnostics(value as FileDiagnostic[] ?? []);
        break;
      }
    }
  };

  const clearActiveMessage = () => {
    setActiveComposerState(undefined);
    setLoading(false);
  }

  return (
    <ComposerContext.Provider value={{
      composerStates,
      setComposerStates: setComposerStates,
      loading, setLoading,
      activeComposerState,
      clearActiveMessage,
      setActiveComposerState,
      activeFiles: chips,
      setActiveFiles: setChips,
      fileDiagnostics: fileDiagnostics ?? [],
      // Thread management
      threads,
      activeThread,
      branchThread,
      createThread,
      switchThread,
      deleteThread,
      renameThread
    }}>
      {children}
    </ComposerContext.Provider>
  );
};

const reconcileMessages = (prev: ComposerState, state: ComposerState) => {
  for (const message of state.messages) {
    // Find any existing message with the same ID, regardless of type
    const matchingMessage = prev?.messages.find(m =>
      m.id === message.id &&
      m.role === message.role);

    if (!matchingMessage) {
      // If no matching message found, add the new message
      // Always add tool messages, and also add non-tool messages
      prev?.messages.push(message);
    } else if (matchingMessage.role === message.role) {
      // Only update content if the roles match (tool updates tool, assistant updates assistant)
      // This prevents a tool message from overwriting an assistant message with the same ID
      matchingMessage.content = message.content;
    }
  }

  return {
    ...state,
    messages: [...(prev?.messages ?? [])]
  }
};