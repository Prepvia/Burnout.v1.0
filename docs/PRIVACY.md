# Burnout for Gmail: where your data goes

Last updated: October 17, 2026.

Burnout for Gmail is an open-source Chrome extension that you install yourself from this
repository. It writes email replies in Gmail using the artificial intelligence (AI) you choose,
with your own key, a model on your own computer, or the AI your company already has. It has no
server and no account: nobody behind it, its authors included, receives anything.

## What Burnout reads

- The email that is open in your Gmail, while the Burnout panel is open, to show it in the panel.
  It goes to your AI only when you ask for a reply or an explanation, or ask a question about it.
- If you turn on **Auto-draft** (a switch at the top of the Burnout panel, off unless you turn it on):
  each email you open while the Burnout panel is open, so its reply is ready as a Gmail draft.
- The text you selected with the mouse, when you click "Selected text".
- The emails you sent, only when you click "Learn from my sent emails". Of those, only the messages
  you wrote yourself go to the AI, with their date, recipient and subject. Other people's messages
  are left out.

## Where it goes

Only to the AI you chose, straight from your browser, and only to produce the text you asked for:

- **Google Gemini, OpenAI or Anthropic**, over HTTPS. Each one handles the text under its own policy:
  - Google Gemini: on the free plan, Google uses what you send to improve its products, people at
    Google may read it, and Google asks you not to send personal or confidential information
    there. With billing turned on in Google AI Studio (from $5), it does not; in the EU, the UK and
    Switzerland, the paid-plan terms apply to free use too (ai.google.dev/gemini-api/terms). The
    settings screen tells you this before you connect it.
  - OpenAI: does not use API data to train its models (openai.com/policies).
  - Anthropic: does not use API data to train its models (anthropic.com/legal).
- **Another AI you set up** (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together or another server
  in the same format), over HTTPS, under that service's policy.
- **Your company's AI**, at the address you entered in the settings, over HTTPS.
- **A model on your own computer** (Ollama, LM Studio): then the text does not leave your computer.

Nowhere else. There is no Burnout server: its authors never receive, store, sell or share any of
your emails, keys, profile or memory.

## What is stored, and where

Everything stays in your browser (the extension's local storage), never on a server:

- the AI settings: which AI, the model, the address (for Other AI or Company AI) and the key;
- the profile you filled in: name, what you do, services, hours, booking link, signature, what
  never to promise, writing style and your other email addresses;
- the memory you wrote (up to 60 items), some of it tied to one person ("Only for Sarah");
- what Burnout learned from your sent emails:
  - up to 120 facts, which may include names, prices and terms. A price or term you gave a client
    is tied to that client's email address and only goes into replies to them;
  - a summary of your writing style;
  - up to 3 excerpts of emails you wrote, as style examples;
  - the "Send mail as" addresses it recognized as yours;
  - which conversations it already read, so it doesn't read them again;
- the notes on each conversation: what you asked to change, with the date and the conversation's
  subject (up to 10 per conversation, for the last 200 conversations);
- the questions you asked Burnout about each conversation and its answers, which may include a
  summary, a translation and excerpts of the email (up to 10 per conversation, for the last 100
  conversations);
- whether Auto-draft is on, and which conversations it already drafted (the conversation's id and
  its message count, no content: up to the last 500);
- the number of AI requests this month.

Whole emails are not stored: Burnout reads them when you ask, uses them and discards them. Only the
pieces listed above are kept.

The backup (Settings > Memory > Download backup) is a file with all of the above, saved wherever
you choose. The AI key goes in it only if you tick that option, and then it is stored as plain text
in the file.

## What Burnout does not do

- It does not send email. It puts the reply in Gmail's reply box, and you are the one who sends it.
- It does not delete, archive or change any email.
- It does not send anything to your AI on its own. It reads the email you open while the panel is
  open, to show it in the panel; that email goes to your AI only when you click a button, or as
  soon as you open it while Auto-draft is on. Learn reads your sent threads, and only the messages
  you wrote go to your AI.
- It does not use your data for ads, for credit or for anything other than writing and explaining
  emails for you.

## Your controls

- Settings > Memory: delete whatever you want (memory items, and the notes on each conversation in
  Conversation notes > Delete notes) and download a backup. In the panel, each note on the open
  conversation also has a trash button to delete it.
- Settings > Privacy > "Delete everything in Burnout": removes the key, profile, memory, notes and
  conversations from this browser.
- Removing the extension from Chrome deletes everything it stored.

## Questions

The code is all here, so you can check every point above yourself. Questions and problems: open an
issue in this repository.
