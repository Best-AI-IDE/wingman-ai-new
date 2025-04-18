# Agent Features

Wingman offers several agent features that cater to different use cases.

## Vibe Mode

Vibe Mode will auto accept commands generated by the agent, along with code edits. You have the opportunity to undo accepted code changes even after they are accepted so you can rollback. After undoing a change you can review the diff and apply the edit again if you wish.

This mode is particularly effective if you are confident working with the agent in your project.

## Regular Mode

Regular Mode will prompt you to review file edits and commands before applying them. This mode is great if you want to be cautious and review each change before its made.

The key advantage to this mode, while it may "feel slower", is that it allows for a more deliberate and controlled development process, ensuring that every change is intentional and thoroughly vetted before integration. If you decide to **reject** a change, the agent will ask you how it should proceed or how to course correct.

![](/RegularMode.png)

## Auto Fix Linting/Import Errors

Wingman now has the ability to detect linting and typescript errors and automatically fix them. You can choose to manually fix them via a button, or you can enable automatic fixes.