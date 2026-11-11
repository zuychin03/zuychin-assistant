# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One owner, who built it and is its only user. They use the web app as an installed phone PWA and in a desktop browser about equally: quick chats, check-ins and captures on the phone, long research, study and agent sessions at the desk. The same assistant also answers in Discord (the life-ops dashboard) and Telegram (quick chat).

## Product Purpose

Zuychin is a personal AI assistant that runs the owner's day and keeps their second brain. It chats across model providers, remembers durable facts and past messages, manages calendar, mail, tasks and scheduled jobs, decides on its own when something is worth a nudge, and files research, study material and captures into a long-form wiki vault. Success is the owner trusting it to run things and returning to it as the place where their knowledge lives.

## Positioning

A single assistant that is both chief of staff and study partner: the conversation, the vault, the task list and the agents behind them are one system that remembers across web, Discord and Telegram, rather than a chat window bolted onto separate tools.

## Operating Context

- Chat home: conversation list with projects, per-message model picker, file upload, hands-free voice loop, agent mode with live step streaming, resumable runs, a Today card in the empty state, and Council launch cards.
- Workspaces sharing one shell: Library (knowledge and vault), Research, Study, Capture, Tasks, and Dashboard (facts, agents and keys, skills, run review).
- Council: a live room where external coding agents deliberate and work, driven by a local host.
- Knowledge Cosmos (`/graph`): a 3D graph of the vault drawn as a planetarium of stars and orbits.
- Passkey-first sign-in with password plus TOTP recovery.

## Capabilities and Constraints

- Next.js app, styled with global CSS tokens, CSS modules and inline style objects; Hanken Grotesk and Azeret Mono are the faces (V7 Atlas rehaul).
- Production runs as a Next standalone server on a free Oracle VM behind Cloudflare Tunnel; every service must stay free.
- The repository is public: no personal names, emails or real domains in source or UI copy.
- Light and dark themes must both exist, following the system by default with a manual toggle.
- The Knowledge Cosmos stays dark-only and keeps its planetarium concept; only its surrounding chrome may change.

## Brand Commitments

- The name Zuychin and the existing Z-and-agent mark (`public/favicon.svg`, `public/zuychin-logo.svg`) stay unchanged.
- The Assistant is one of a family of Zuychin apps (Photobooth, Gallery, Arcade, Deploy Hub). Each has its own visual world; the Assistant gets a distinct world of its own, tied to the family only by the mark and the name.
- Character: a mix of a composed, capable chief of staff and a curious second-brain study partner.
- It must not come across as cute or playful, as corporate SaaS, or as precious and slow.

## Evidence on Hand

- Real product content: model names, workspace names, feature copy in `README.md`, and the owner's own conversations, vault pages and tasks behind sign-in.
- No testimonials, metrics or public marketing claims exist, and none should be invented.

## Product Principles

1. One system, not a set of tools: every surface should read as part of the same assistant.
2. Quick on the phone, deep at the desk: fast capture and chat must never wait on the depth that long sessions need.
3. Trust through legibility: show what Zuychin knows, did and plans to do, without exposing machinery for its own sake.
4. Knowledge is first-class: the vault and what was learned are as present as the conversation.
