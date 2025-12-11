# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-12-10
### Added
- Release notes file to surface change history directly on the VS Code Marketplace listing.
- Rich terminal action output cards with default-open state, success/error badges, and truncation-aware command headings.
- Automatic remediation TODO lists when an action fails; steps can be replayed (with confirmation) directly from the chat view.

### Changed
- Action preview/result bubbles now reuse the assistant styling only when useful, keeping the UI focused on the interactive cards.
- Enhanced Go/terminal PATH injection and tightened action JSON instructions so generated commands are immediately executable.

### Fixed
- Suppressed duplicate assistant/system bubbles for actions so only the styled `message-action` block remains visible.

## [0.1.0] - 2025-09-01
- Initial public release with chat view, action execution, and inline completion support for local Ollama models.
