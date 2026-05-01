# postmaxx_

Turn your Claude Code sessions into building-in-public posts. Surfaces the **reasoning** behind your decisions — not changelogs, not hype.

## Requirements

- Node.js 18+
- [Claude Code](https://claude.ai/code) installed and used at least once

## Setup

**1. Clone and enter the repo**
```bash
git clone https://github.com/myrondoesnotcode/postmaxxing
cd postmaxxing
```

**2. Add your Anthropic API key**

Get one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), then:
```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
```

**3. Run it**
```bash
node devlog.js
```

That's it. It finds your most recent Claude Code session, extracts the reasoning, and generates a post.

## Usage

```bash
node devlog.js                    # most recent session
node devlog.js --ui               # open web UI in browser
node devlog.js --list             # pick a session interactively
node devlog.js --mode technical   # engineering lens instead of story
node devlog.js --count 3          # generate 3 candidates
node devlog.js --days 7           # look back 7 days
node devlog.js --project myapp    # filter by project name
```

## Posting threads

Add a Typefully API key to your `.env` to post threads directly:
```
TYPEFULLY_API_KEY=your-key-here
```

Get one free at [typefully.com](https://typefully.com) → Settings → API.

Single tweets post directly to X via the browser. Threads go through Typefully.

## Web UI

```bash
node devlog.js --ui
```

Opens at [http://localhost:3000](http://localhost:3000). Pick a session, generate candidates, edit and post.
