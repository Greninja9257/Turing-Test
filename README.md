# The Turing Test Game

A multiplayer game where players try to identify which participant is an AI.

## Setup

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your API key:
```bash
OPENROUTER_API_KEY=your-api-key-here
```

3. Run the server:
```bash
npm start
```

4. Open `http://localhost:3001` in your browser

### Replit Deployment

1. Fork/Import this repository to Replit

2. Add Secret (Environment Variable):
   - Click on the "Secrets" tab (lock icon) in the left sidebar
   - Add a new secret:
     - Key: `OPENROUTER_API_KEY`
     - Value: Your OpenRouter API key from https://openrouter.ai/keys

3. Click "Run" - Replit will automatically:
   - Install dependencies
   - Start the server
   - Provide you with a public URL

4. Share the URL with friends to play!

## How to Play

1. Join the queue and wait for other players
2. You'll be assigned a player number automatically
3. One AI will join your game as a player
4. Chat naturally - no topics, just conversation
5. After 5 minutes, vote who you think is the AI
6. Humans win if they correctly identify the AI

## Environment Variables

- `OPENROUTER_API_KEY` (required): Your OpenRouter API key
- `PORT` (optional): Server port (default: 3001)
