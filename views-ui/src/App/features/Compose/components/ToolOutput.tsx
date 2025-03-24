import type { ComposerMessage, ToolMessage } from "@shared/types/Composer";
import { useMemo, useState, useEffect, useRef } from "react";
import {
    AiOutlineLoading3Quarters,
    AiOutlineCheckCircle,
    AiOutlineCloseCircle,
} from "react-icons/ai";
import { BsTools } from "react-icons/bs";
import { getTruncatedPath, openFile } from "../../../utilities/files";
import type { FileMetadata } from "@shared/types/Message";
import { AiOutlineUp, AiOutlineDown } from "react-icons/ai";
import { vscode } from "../../../utilities/vscode";
import { HiOutlineSave } from "react-icons/hi";

const ToolNames = {
    list_directory: "Searched: ",
    find_file_dependencies: "Checked Dependencies",
    read_file: "Analyzed: ",
    research: "Researching...",
    semantic_search: "Semantic search...",
    think: "Thinking..."
};

export interface ToolOutputProps {
    messages: ToolMessage[];
    isLightTheme: boolean;
    loading: boolean;
}

export const ToolOutput = ({
    messages,
    isLightTheme,
    loading
}: ToolOutputProps) => {
    //@ts-expect-error
    const knownToolName = ToolNames[messages[0].name];
    const displayName = knownToolName ?? messages[0].name;
    const toolIsLoading = messages.length === 1;

    const ToolDetails = useMemo(() => {
        if (!messages) return null;

        try {
            const toolName = messages[0].name;

            if (toolName === "list_directory") {
                let content = messages[0].content;
                content = typeof (content) === "string" ? JSON.parse(content) : content;
                //@ts-expect-error
                return content.directory;
            }

            if (toolName === "read_file") {
                const content: Record<string, unknown> | string = toolIsLoading ? messages[0].content : messages[1].content;
                const fileContent = (typeof (content) === "string" ? JSON.parse(content) : content) as FileMetadata;
                return <span
                    className="cursor-pointer hover:underline transition-all"
                    onClick={() => openFile({
                        path: fileContent.path
                    })}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openFile({
                                path: fileContent.path
                            });
                        }
                    }}>{fileContent?.path ? getTruncatedPath(fileContent.path) : ""}</span>
            }
        } catch (error) {
            console.error("Failed to parse tool content:", error);
        }

        return null;
    }, [messages, messages[0].name, messages[0].content, toolIsLoading]);

    const cssClasses = `${isLightTheme
        ? "bg-white shadow-[0_2px_4px_rgba(0,0,0,0.1),0_8px_16px_rgba(0,0,0,0.1)] hover:shadow-[0_4px_8px_rgba(0,0,0,0.15),0_12px_24px_rgba(0,0,0,0.15)]"
        : "bg-[#1e1e1e] shadow-[0_2px_4px_rgba(0,0,0,0.2),0_8px_16px_rgba(0,0,0,0.2)] hover:shadow-[0_4px_8px_rgba(0,0,0,0.25),0_12px_24px_rgba(0,0,0,0.25)]"
        }`;

    return (
        <div
            className={`rounded-lg overflow-hidden shadow-lg ${cssClasses}`}
        >
            <div className="text-[var(--vscode-input-foreground)] flex flex-col">
                <div className="flex items-center justify-between relative p-3">
                    <div className="flex items-center gap-2 overflow-hidden">
                        <BsTools className="text-gray-400/50 flex-shrink-0" size={20} />
                        <div className="overflow-x-auto max-w-full" style={{ scrollbarWidth: 'thin' }}>
                            <h4 className="m-0 text-base whitespace-nowrap text-gray-400/50">
                                {displayName} {ToolDetails}
                            </h4>
                        </div>
                    </div>

                    <div className="flex items-center ml-3 flex-shrink-0">
                        {toolIsLoading && loading && (
                            <div className="flex justify-center">
                                <AiOutlineLoading3Quarters
                                    className="animate-spin text-stone-400"
                                    size={20}
                                />
                            </div>
                        )}
                        {toolIsLoading && !loading && (
                            <div className="flex justify-center">
                                <AiOutlineCloseCircle className="text-gray-400/50" size={20} />
                            </div>
                        )}
                        {!toolIsLoading && (
                            <div className="flex justify-center">
                                <AiOutlineCheckCircle className="text-gray-400/50" size={20} />
                            </div>
                        )}
                    </div>
                </div>
                {!knownToolName && !toolIsLoading && (
                    <ComplexTool messages={messages} isLightTheme={isLightTheme} />
                )}
            </div>
        </div>
    );
};

interface ToolImageContent {
    type: "image_url"
    image_url: {
        url: string;
    }
}

interface ToolTextContent {
    type: "text",
    text: string;
}

interface ContextMenuPosition {
    x: number;
    y: number;
}

interface ImageContextMenuProps {
    position: ContextMenuPosition;
    onClose: () => void;
    onSave: () => void;
    isLightTheme: boolean;
}

const ImageContextMenu = ({ position, onClose, onSave, isLightTheme }: ImageContextMenuProps) => {
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [onClose]);

    // Apply a small offset to position the menu exactly at the cursor
    const menuStyle = {
        top: `${position.y}px`,
        left: `${position.x}px`,
        transform: 'translate(-5px, -5px)' // Adjust the menu position to align with cursor
    };

    const menuClasses = `${isLightTheme
        ? "bg-white text-gray-800 border border-gray-200"
        : "bg-[#252526] text-gray-200 border border-gray-700"
        }`;

    return (
        <div
            ref={menuRef}
            className={`fixed z-50 rounded shadow-lg ${menuClasses}`} // Changed from absolute to fixed
            style={menuStyle}
        >
            <ul className="py-1">
                <li
                    className="px-4 py-2 hover:bg-[var(--vscode-list-hoverBackground)] flex items-center gap-2 cursor-pointer"
                    onClick={() => {
                        onSave();
                        onClose();
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSave();
                            onClose();
                        }
                    }}
                >
                    <HiOutlineSave size={16} />
                    <span>Save As...</span>
                </li>
            </ul>
        </div>
    );
};

const ComplexTool = ({ messages, isLightTheme }: { messages: ComposerMessage[], isLightTheme: boolean }) => {
    const [collapsed, setCollapsed] = useState(false);
    const [contextMenu, setContextMenu] = useState<{
        visible: boolean;
        position: ContextMenuPosition;
        imageUrl: string;
    }>({
        visible: false,
        position: { x: 0, y: 0 },
        imageUrl: ''
    });

    const lastMessage = messages[messages.length - 1];

    if (!Array.isArray(lastMessage.content)) return null;

    const toolContent: Array<ToolImageContent | ToolTextContent> = lastMessage.content as unknown as Array<ToolImageContent | ToolTextContent>;

    const saveImage = (imageBase64: string) => {
        vscode.postMessage({
            command: 'save-image',
            value: imageBase64
        });
    };

    const handleContextMenu = (e: React.MouseEvent, imageUrl: string) => {
        e.preventDefault();
        // Use pageX and pageY for more accurate positioning
        setContextMenu({
            visible: true,
            position: { x: e.pageX, y: e.pageY },
            imageUrl
        });
    };

    const closeContextMenu = () => {
        setContextMenu(prev => ({ ...prev, visible: false }));
    };

    return (
        <div className="relative p-3">
            <div className="flex items-center justify-between mb-2">
                <h4 className="m-0 text-base whitespace-nowrap text-gray-400/50">
                    Tool Output:
                </h4>
                <button
                    type="button"
                    className="flex pr-0 items-center justify-center p-1 text-gray-400/70 hover:text-gray-400 rounded hover:bg-[var(--vscode-list-hoverBackground)] focus:outline-none focus:ring-1 focus:ring-[var(--vscode-focusBorder)] transition-colors"
                    onClick={() => setCollapsed(!collapsed)}
                    aria-label={collapsed ? "Expand tool output" : "Collapse tool output"}
                    aria-expanded={!collapsed}
                >
                    {collapsed ? (
                        <AiOutlineDown size={20} aria-hidden="true" />
                    ) : (
                        <AiOutlineUp size={20} aria-hidden="true" />
                    )}
                </button>
            </div>
            {!collapsed && (
                <div className="flex flex-col gap-2">
                    {toolContent.map((content, index) => {
                        if (content.type === "image_url") {
                            return (
                                <div key={`image-${// biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
                                    index}`} className="relative">
                                    <img
                                        src={content.image_url.url}
                                        alt="Tool generated"
                                        className="max-w-full h-auto cursor-pointer"
                                        onContextMenu={(e) => handleContextMenu(e, content.image_url.url)}
                                    />
                                </div>
                            );
                        }
                        return null;
                    })}
                </div>
            )}

            {contextMenu.visible && (
                <ImageContextMenu
                    position={contextMenu.position}
                    onClose={closeContextMenu}
                    onSave={() => saveImage(contextMenu.imageUrl)}
                    isLightTheme={isLightTheme}
                />
            )}
        </div>
    );
};