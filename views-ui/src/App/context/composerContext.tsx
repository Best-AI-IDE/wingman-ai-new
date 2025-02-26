import { ComposerMessage, ComposerResponse, FileSearchResult } from "@shared/types/v2/Composer";
import { AppMessage } from "@shared/types/v2/Message";
import { AppState, Thread } from "@shared/types/Settings";
import { AddMessageToThreadEvent, RenameThreadEvent } from '@shared/types/Events';
import React, { createContext, FC, PropsWithChildren, useContext, useEffect, useRef, useState } from "react";
import { vscode } from "../utilities/vscode";

interface ComposerContextType {
  composerMessages: ComposerMessage[];
  setComposerMessages: React.Dispatch<React.SetStateAction<ComposerMessage[]>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  clearActiveMessage: () => void;
  activeMessage: ComposerMessage | undefined;
  activeFiles: FileSearchResult[];
  setActiveFiles: React.Dispatch<React.SetStateAction<FileSearchResult[]>>;
  // Thread management
  threads: Thread[];
  activeThread: Thread | null;
  createThread: (title: string) => void;
  switchThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, newTitle: string) => void;
}

const ComposerContext = createContext<ComposerContextType | undefined>(undefined);

export const useComposerContext = () => {
  const context = useContext(ComposerContext);
  if (!context) throw new Error("useComposerContext must be used within ComposerProvider");
  return context;
};

export const ComposerProvider: FC<PropsWithChildren> = ({ children }) => {
  const [composerMessages, setComposerMessages] = useState<ComposerMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [activeMessage, setActiveMessage] = useState<ComposerMessage | undefined>();
  const [chips, setChips] = useState<FileSearchResult[]>([]);

  // Thread management state
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);

  const threadsRef = useRef<Thread[]>([]);
  const activeThreadRef = useRef<Thread | null>(null);

  // Update refs whenever state changes
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

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
    if (composerMessages.length === 0) {
      setLoading(false);
    }
  }, [composerMessages]);

  const createThread = (title: string) => {
    const timestamp = Date.now();
    const newThread: Thread = {
      id: crypto.randomUUID(),
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: []
    };

    setThreads(prevThreads => [...prevThreads, newThread]);
    setActiveThread(newThread);
    setComposerMessages([]);

    // Notify extension about new thread
    vscode.postMessage({
      command: "create-thread",
      value: newThread
    });
  };

  const switchThread = (threadId: string) => {
    const thread = threads.find(t => t.id === threadId);
    if (thread) {
      setActiveThread(thread);

      // Load messages for this thread
      const threadMessages = thread.messages as ComposerMessage[];
      setComposerMessages(threadMessages || []);

      // Notify extension about thread switch
      vscode.postMessage({
        command: "switch-thread",
        value: threadId
      });
    }
  };

  const deleteThread = (threadId: string) => {
    // Don't delete if it's the only thread
    if (threads.length <= 1) {
      return;
    }

    setThreads(prevThreads => {
      const updatedThreads = prevThreads.filter(t => t.id !== threadId);

      // If we're deleting the active thread, switch to another one
      if (activeThread?.id === threadId && updatedThreads.length > 0) {
        const newActiveThread = updatedThreads[0];
        setActiveThread(newActiveThread);
        setComposerMessages(newActiveThread.messages as ComposerMessage[] || []);
      }

      return updatedThreads;
    });

    // Notify extension about thread deletion
    vscode.postMessage({
      command: "delete-thread",
      value: threadId
    });
  };

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
    const { node, values } = value;

    console.log('Active Msg:', activeMessage?.message);
    console.log('Values:', values);

    switch (node) {
      case "composer-done":
        const newMessage = {
          from: "assistant" as const,
          message: activeMessage?.message ?? "",
          events: values.events,
          threadId: activeThread?.id
        };

        setComposerMessages(prevMessages => [
          ...prevMessages,
          newMessage
        ]);

        vscode.postMessage({
          command: "add-message-to-thread",
          value: { threadId: values.threadId, message: newMessage } satisfies AddMessageToThreadEvent
        });

        setLoading(false);
        setActiveMessage(undefined);
        break;
      case "composer-events":
        setLoading(true);
        setActiveMessage((am) => {
          return {
            from: "assistant",
            message: am?.message || "",
            events: values.events,
            threadId: values.threadId
          }
        });
        break;
    }
  }

  const handleResponse = (event: MessageEvent<AppMessage>) => {
    const { data } = event;
    const { command, value } = data;

    switch (command) {
      case "compose-response":
        handleComposerEvent(value as ComposerResponse);
        break;
      case "thread-data":
        const workspaceSettings = value as AppState;
        const { threads, activeThreadId } = workspaceSettings;
        console.log(threads, activeThreadId)
        // Handle threads data from extension
        if (threads && Array.isArray(threads)) {
          setThreads(threads);

          // Set active thread if available
          if (activeThreadId && threads.length > 0) {
            const thread = threads.find((t: Thread) => t.id === activeThreadId);
            if (thread) {
              setActiveThread(thread);
              setComposerMessages(thread.messages as ComposerMessage[] || []);
            }
          } else if (threads.length > 0) {
            // Default to first thread if no active thread is specified
            setActiveThread(threads[0]);
            setComposerMessages(threads[0].messages as ComposerMessage[] || []);
          }
        }
        break;
    }
  };

  const clearActiveMessage = () => {
    const cancelledMessage = {
      from: "assistant" as const,
      message: activeMessage?.message ?? "",
      threadId: activeThread?.id
    };

    setComposerMessages((currentMessages) => {
      return [
        ...currentMessages,
        cancelledMessage
      ];
    });

    // Update thread with cancelled message
    if (activeThread) {
      setThreads(prevThreads => {
        return prevThreads.map(thread => {
          if (thread.id === activeThread.id) {
            return {
              ...thread,
              messages: [...thread.messages, cancelledMessage],
              updatedAt: Date.now()
            };
          }
          return thread;
        });
      });

    }

    setActiveMessage(undefined);
    setLoading(false);
  }

  return (
    <ComposerContext.Provider value={{
      composerMessages,
      setComposerMessages,
      loading, setLoading,
      activeMessage,
      clearActiveMessage,
      activeFiles: chips,
      setActiveFiles: setChips,
      // Thread management
      threads,
      activeThread,
      createThread,
      switchThread,
      deleteThread,
      renameThread
    }}>
      {children}
    </ComposerContext.Provider>
  );
};