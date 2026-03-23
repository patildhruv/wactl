# The Great WhatsApp ToS Conspiracy

Meta's Terms of Service say: *"Don't use unofficial clients or reverse-engineered protocols."* Violators get banned.

And yet.

---

## The Evidence

[**mautrix-whatsapp**](https://github.com/mautrix/whatsapp) — a Matrix bridge built directly on top of [whatsmeow](https://github.com/tulir/whatsmeow) (the same "illegal" protocol wactl uses) — has been running continuously for thousands of self-hosters since **August 2018**. That's 8 years. 1,700+ GitHub stars. 58 releases. The latest: [v0.2603.0](https://github.com/mautrix/whatsapp/releases), March 2026.

It's not hiding:
- [Helm charts on ArtifactHub](https://artifacthub.io/packages/helm/halkeye/mautrix-whatsapp) with multiple maintainers
- [FreeBSD port](https://www.freshports.org/net-im/mautrix-whatsapp/) in the official ports tree
- A fully public GitHub repo with 2,037 commits
- Active Matrix community at `#whatsapp:maunium.net`

[**whatsmeow**](https://github.com/tulir/whatsmeow) itself — the Go library that powers all of this — has **5,600+ stars**, 891 forks, and is used by **~2,000 projects**. Maintained by tulir, actively updated through 2026. MPL-2.0 licensed.

[**Baileys**](https://github.com/WhiskeySockets/Baileys), the TypeScript equivalent, has **7,900+ stars** and 2,600+ forks. Also actively maintained. Also not banned into oblivion.

None of these projects are hiding. None of them have been taken down. Their users haven't been mass-banned.

---

## So Who Actually Gets Banned?

WhatsApp blocks [**500,000+ accounts per day**](https://faq.whatsapp.com/465883178708358). The targets:

| What gets you banned | Ban rate |
|---|---|
| Bulk/automated messaging without opt-in | ~89% |
| Modified WhatsApp clients (GB WhatsApp, WhatsApp Plus) | ~32% of all bans |
| Spam to users who didn't opt in | High |
| Using scraped/purchased contact lists | High |
| Automated account creation | High |
| **Personal bridge users following normal usage** | **~0.7%** |

75% of bans are detected **proactively by algorithms** — not user reports. The algorithms look for spam patterns, not protocol implementations.

The mautrix-whatsapp documentation itself [states](https://docs.mau.fi/bridges/go/whatsapp/authentication.html): *"Just using the bridge shouldn't cause any bans."*

---

## The Real Enforcement Pattern

Meta doesn't ban you for using an unofficial client. **They ban you for being annoying.**

The enforcement is a business model protection mechanism aimed at:

### 1. Competitors building on WhatsApp for free

In **October 2025**, Meta [changed their Terms of Service](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/) to explicitly ban "general-purpose chatbots" from the WhatsApp Business API. Effective **January 15, 2026**, ChatGPT, Microsoft Copilot, and Perplexity were kicked off the platform — affecting over **50 million users** who accessed ChatGPT through WhatsApp.

The reason? These AI assistants *were the product*, not a customer support tool. They didn't generate revenue for WhatsApp's Business API (which charges per message template). They competed directly with Meta AI.

Customer service chatbots? Still allowed. AI assistants where the bot *is* the value? Banned. The line isn't about technology — it's about who's making money.

### 2. Spam and bulk senders who don't pay for the official API

WhatsApp Business API charges for message templates (marketing, utility, authentication). Spammers using unofficial libraries to blast messages bypass this entirely. That's lost revenue + user complaints. Double motivation to ban.

### 3. Anyone competing with Meta AI

Meta launched their own AI assistant across WhatsApp, Instagram, and Messenger. Every third-party AI chatbot on WhatsApp is now a competitor. The ToS change was strategic, not principled.

---

## Where Personal Bridges Fit

A person quietly bridging their own WhatsApp to their LLM so they can search their messages from Claude? Meta has approximately zero business reason to care:

- You're still on their platform
- Your messages still flow through their servers
- Your metadata is still theirs
- You're not competing with Meta AI
- You're not spamming anyone
- You're actually *more* locked into WhatsApp (because now your AI tools depend on it)

Individual privacy nerds running mautrix or wactl are **good for Meta** — they keep users on WhatsApp instead of leaving for Signal or Telegram.

---

## The Bottom Line

The ToS is a **legal sword, not an operational policy**. It exists so Meta can ban anyone they want, whenever they want, with zero obligation to explain why.

mautrix-whatsapp users are tolerated until they're not — and that line moves based on Meta's quarterly earnings call, not your behavior.

**Should you worry?** The data says no — if you're using wactl for personal messaging (reading your own chats, sending to your own contacts), you're in the same category as thousands of mautrix users who've been doing this for 8 years without issues.

**Should you be aware of the risk?** Absolutely. Your account, your responsibility. See our [Disclaimer](README.md#disclaimer).

---

*Last updated: March 2026*

*Sources: [WhatsApp Help Center](https://faq.whatsapp.com/465883178708358) · [TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/) · [mautrix-whatsapp](https://github.com/mautrix/whatsapp) · [whatsmeow](https://github.com/tulir/whatsmeow) · [Baileys](https://github.com/WhiskeySockets/Baileys) · [WhatsApp Policy Enforcement](https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement)*
