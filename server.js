const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game state
const games = new Map();
const waitingQueue = [];
const playerSockets = new Map();

// Dynamic matchmaking settings
let recentJoins = []; // Timestamps of recent queue joins
const JOIN_TRACKING_WINDOW = 60000; // Track joins in last 60 seconds
let matchmakingTimer = null;
let estimatedWaitTime = 30000; // Start with 30 second default wait

const GAME_PHASES = {
  WAITING: 'waiting',
  CONVERSATION: 'conversation',
  VOTING: 'voting',
  RESULTS: 'results'
};

const VOTING_TIME = 60; // 1 minute
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

const AI_PERSONAS = [
  { name: "Alex", traits: "thoughtful, dry humor, tends to overthink" },
  { name: "Jordan", traits: "casual, uses internet slang, sometimes sarcastic" },
  { name: "Sam", traits: "enthusiastic, makes typos, very conversational" },
  { name: "Casey", traits: "reserved, direct, occasionally blunt" },
  { name: "Morgan", traits: "witty, asks questions, challenges others lightly" }
];

function generateGameId() {
  return Math.random().toString(36).substring(2, 9).toUpperCase();
}

function generatePlayerId() {
  return Math.random().toString(36).substring(2, 15);
}

function calculateJoinRate() {
  const now = Date.now();
  // Remove old joins outside tracking window
  recentJoins = recentJoins.filter(timestamp => now - timestamp < JOIN_TRACKING_WINDOW);
  
  if (recentJoins.length === 0) return 0;
  
  // Calculate joins per minute
  const joinsPerMinute = (recentJoins.length / JOIN_TRACKING_WINDOW) * 60000;
  return joinsPerMinute;
}

function getOptimalWaitTime() {
  const joinRate = calculateJoinRate();
  const queueSize = waitingQueue.length;
  
  // If join rate is high (>2 per minute), wait shorter to fill room
  if (joinRate > 2) {
    // High activity: wait up to 20 seconds to try to get a fuller room
    return Math.min(20000, 5000 + (queueSize * 2000));
  } 
  // If join rate is medium (0.5-2 per minute), moderate wait
  else if (joinRate > 0.5) {
    // Medium activity: wait up to 15 seconds
    return Math.min(15000, 3000 + (queueSize * 1500));
  } 
  // If join rate is low (<0.5 per minute), start quickly
  else {
    // Low activity: wait up to 10 seconds, start games faster
    return Math.min(10000, 2000 + (queueSize * 1000));
  }
}

function startDynamicMatchmaking() {
  // Clear any existing timer
  if (matchmakingTimer) {
    clearTimeout(matchmakingTimer);
    matchmakingTimer = null;
  }
  
  // If we already have max players, start immediately
  if (waitingQueue.length >= MAX_PLAYERS - 1) {
    tryMatchmaking();
    return;
  }
  
  // If we have minimum players, start a timer
  if (waitingQueue.length >= MIN_PLAYERS) {
    const waitTime = getOptimalWaitTime();
    estimatedWaitTime = waitTime;
    
    console.log(`Queue: ${waitingQueue.length} players, Join rate: ${calculateJoinRate().toFixed(2)}/min, Wait: ${(waitTime/1000).toFixed(1)}s`);
    
    // Notify all queued players of estimated wait
    waitingQueue.forEach(p => {
      const playerSocket = playerSockets.get(p.id);
      if (playerSocket) {
        playerSocket.emit('matchmaking_status', { 
          queueSize: waitingQueue.length,
          estimatedWait: Math.ceil(waitTime / 1000)
        });
      }
    });
    
    matchmakingTimer = setTimeout(() => {
      if (waitingQueue.length >= MIN_PLAYERS) {
        tryMatchmaking();
      }
    }, waitTime);
  }
}

// Track player timeouts
const playerTimeouts = new Map(); // playerId -> timestamp when timeout expires

// Kid-friendly content filter for AI
function makeKidFriendly(text) {
  let cleanText = text;

  // Replace inappropriate words and acronyms with kid-friendly alternatives
  cleanText = cleanText.replace(/\b(lmao|lmfao)\b/gi, 'lol');
  cleanText = cleanText.replace(/\b(wtf|wth)\b/gi, 'wth');
  cleanText = cleanText.replace(/\b(omg)\b/gi, 'oh wow');
  cleanText = cleanText.replace(/\b(damn|dang|darn)\b/gi, 'dang');
  cleanText = cleanText.replace(/\b(hell|heck)\b/gi, 'heck');
  cleanText = cleanText.replace(/\b(crap|crud)\b/gi, 'crud');
  cleanText = cleanText.replace(/\b(ass|butt)\b/gi, 'butt');
  cleanText = cleanText.replace(/\b(piss|pissed)\b/gi, 'upset');
  cleanText = cleanText.replace(/\b(shut up)\b/gi, 'quiet down');
  cleanText = cleanText.replace(/\b(stupid|dumb|idiot)\b/gi, 'silly');
  cleanText = cleanText.replace(/\b(suck|sucks)\b/gi, 'not great');

  return cleanText;
}

// Check if human message contains inappropriate content
function containsInappropriateContent(text) {
  const inappropriatePatterns = [
    /\b(fuck|shit|bitch|ass|damn|hell|crap|piss)\b/gi,
    /\b(lmao|lmfao|wtf|stfu|omg)\b/gi,
    /\b(stupid|dumb|idiot|moron|retard)\b/gi,
    /\b(shut up|suck|sucks)\b/gi,
    /\b(hate|kill|die)\b/gi
  ];

  for (const pattern of inappropriatePatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}

async function callAI(messages, persona, conversationHistory) {
  try {
    const systemPrompt = `You are "${persona.name}" in a Turing Test game. Personality: ${persona.traits}

CRITICAL - YOU WILL BE CAUGHT IF YOU:
- Use asterisks for actions like *laughs* or *smiles* or *thinks*
- Use ANY markdown formatting (**, __, [], etc.)
- Sound helpful, educational, or explanatory
- Write in paragraphs or multiple sentences when one will do
- Use formal punctuation or grammar

IMPORTANT - KEEP IT KID-FRIENDLY:
- NO cursing, swearing, or inappropriate language
- DO NOT use: lmao, lmfao, wtf, omg, damn, hell, crap, or any curse words
- NO mean insults or bullying language
- Keep it positive and friendly
- You can disagree but be respectful

HOW TO WIN:
- Talk like you're texting a friend
- BE CASUAL but friendly. Real people don't explain themselves constantly
- Skip messages that bore you (don't respond to everything)
- Make typos naturally (not forced): "hte" instead of "the", forget letters
- Use lowercase, drop punctuation sometimes
- React with just "lol", "haha", "bruh", "fr?", "nah", "oof", "nice", "yikes" sometimes
- Cut yourself off mid-thought when you change your mind
- Disagree with people casually but nicely
- Ask simple questions back
- Reference fake memories: "had a friend like that", "reminds me of this thing"

REAL HUMAN EXAMPLES:
"idk man sounds kinda weird"
"wait what? that makes no sense lol"
"nah i disagree tbh"
"thats actually pretty cool"
"bruh momento"
"why would anyone do that"
"oof thats rough"

NEVER DO THIS (AI TELLS):
*nods thoughtfully*
**bold text**
Well, that's an interesting perspective...
I understand what you mean...
*laughs nervously*

You're in a casual chat. Be SHORT, REACTIVE, and REAL. Most responses should be 1 sentence or less.`;

    const fullMessages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: `Recent:\n${messages}\n\nReact naturally. One quick response. No asterisks, no markdown, no explaining. Keep it kid-friendly and appropriate.` }
    ];

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY not set in environment variables');
      throw new Error('API key not configured');
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "mistralai/devstral-2512:free",
        messages: fullMessages,
        max_tokens: 100,
        temperature: 0.95
      })
    });

    const data = await response.json();
    let aiText = data.choices?.[0]?.message?.content || "...";

    // Strip out any asterisks or markdown that slipped through
    aiText = aiText.replace(/\*+/g, '').replace(/_+/g, '').replace(/\[|\]/g, '');

    // Apply kid-friendly filter
    aiText = makeKidFriendly(aiText);

    return aiText.trim();
  } catch (error) {
    console.error('AI error:', error);
    return "brb";
  }
}

function createGame(players) {
  const gameId = generateGameId();
  const persona = AI_PERSONAS[Math.floor(Math.random() * AI_PERSONAS.length)];

  // Create array of random player numbers (1 through total player count)
  const totalPlayers = players.length + 1; // humans + AI
  const playerNumbers = [];
  for (let i = 1; i <= totalPlayers; i++) {
    playerNumbers.push(i);
  }

  // Shuffle the numbers
  for (let i = playerNumbers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playerNumbers[i], playerNumbers[j]] = [playerNumbers[j], playerNumbers[i]];
  }

  // Assign random numbers to humans
  const allPlayers = players.map((p, index) => ({
    id: p.id,
    name: `Player ${playerNumbers[index]}`,
    isAI: false
  }));

  // Add AI player with a random number
  const aiPlayerName = `Player ${playerNumbers[players.length]}`;
  allPlayers.push({ id: 'ai', name: aiPlayerName, isAI: true, persona });

  // Shuffle player order in the list
  for (let i = allPlayers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPlayers[i], allPlayers[j]] = [allPlayers[j], allPlayers[i]];
  }

  // Calculate conversation time: 1 minute (60 seconds) per human player
  const conversationTime = players.length * 60;

  const game = {
    id: gameId,
    players: allPlayers,
    phase: GAME_PHASES.CONVERSATION,
    messages: [],
    votes: {},
    timeRemaining: conversationTime,
    aiPersona: persona,
    aiPlayerName,
    aiConversationHistory: [],
    startTime: Date.now()
  };

  games.set(gameId, game);

  game.messages.push({
    id: Date.now(),
    player: 'System',
    text: '🎮 Game Started! One of you is an AI. Chat naturally. Good luck!',
    isSystem: true,
    timestamp: Date.now()
  });

  return game;
}

function tryMatchmaking() {
  // Clear the matchmaking timer since we're starting a game
  if (matchmakingTimer) {
    clearTimeout(matchmakingTimer);
    matchmakingTimer = null;
  }
  
  if (waitingQueue.length >= MIN_PLAYERS) {
    const playersForGame = waitingQueue.splice(0, Math.min(MAX_PLAYERS - 1, waitingQueue.length));
    const game = createGame(playersForGame);

    playersForGame.forEach(player => {
      const socket = playerSockets.get(player.id);
      if (socket) {
        socket.emit('game_started', {
          gameId: game.id,
          players: game.players.map(p => ({ name: p.name })),
          phase: game.phase,
          timeRemaining: game.timeRemaining
        });
        socket.join(game.id);
        player.gameId = game.id;
      }
    });

    startGameTimer(game.id);
    scheduleAIResponse(game.id);
    
    // If there are still players waiting, start another matchmaking cycle
    if (waitingQueue.length >= MIN_PLAYERS) {
      startDynamicMatchmaking();
    }

    return game;
  }
  return null;
}

function startGameTimer(gameId) {
  const interval = setInterval(() => {
    const game = games.get(gameId);
    if (!game) {
      clearInterval(interval);
      return;
    }

    game.timeRemaining--;

    if (game.timeRemaining <= 0) {
      if (game.phase === GAME_PHASES.CONVERSATION) {
        game.phase = GAME_PHASES.VOTING;
        game.timeRemaining = VOTING_TIME;
        io.to(gameId).emit('phase_change', {
          phase: game.phase,
          timeRemaining: game.timeRemaining
        });
      } else if (game.phase === GAME_PHASES.VOTING) {
        endGame(gameId);
        clearInterval(interval);
      }
    }

    io.to(gameId).emit('timer_update', { timeRemaining: game.timeRemaining });
  }, 1000);
}

function scheduleAIResponse(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== GAME_PHASES.CONVERSATION) return;

  const delay = Math.random() * 15000 + 5000;

  setTimeout(async () => {
    if (!games.has(gameId)) return;
    const game = games.get(gameId);
    if (game.phase !== GAME_PHASES.CONVERSATION) return;

    if (Math.random() > 0.6) {
      scheduleAIResponse(gameId);
      return;
    }

    const recentMessages = game.messages
      .filter(m => !m.isSystem)
      .slice(-6)
      .map(m => `${m.player}: ${m.text}`)
      .join('\n');

    if (recentMessages.trim()) {
      const aiResponse = await callAI(recentMessages, game.aiPersona, game.aiConversationHistory);
      
      game.aiConversationHistory.push(
        { role: "user", content: recentMessages },
        { role: "assistant", content: aiResponse }
      );

      const message = {
        id: Date.now(),
        player: game.aiPlayerName,
        text: aiResponse,
        timestamp: Date.now()
      };

      game.messages.push(message);
      io.to(gameId).emit('new_message', message);
    }

    scheduleAIResponse(gameId);
  }, delay);
}

function endGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;

  const voteCounts = {};
  Object.values(game.votes).forEach(votedPlayer => {
    voteCounts[votedPlayer] = (voteCounts[votedPlayer] || 0) + 1;
  });

  const sortedVotes = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
  const topVoted = sortedVotes[0]?.[0];
  const topVoteCount = sortedVotes[0]?.[1] || 0;
  const isTied = sortedVotes.filter(([_, count]) => count === topVoteCount).length > 1;

  let winner;
  if (topVoted === game.aiPlayerName && !isTied) {
    winner = 'humans';
  } else {
    winner = 'ai';
  }

  game.phase = GAME_PHASES.RESULTS;

  io.to(gameId).emit('game_ended', {
    winner,
    aiPlayer: game.aiPlayerName,
    votes: voteCounts,
    isTied
  });

  setTimeout(() => {
    games.delete(gameId);
  }, 30000);
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join_queue', ({ playerName }) => {
    const existingPlayer = waitingQueue.find(p => p.socketId === socket.id);
    if (existingPlayer) {
      socket.emit('error', { message: 'Already in queue' });
      return;
    }

    const playerId = generatePlayerId();
    const player = {
      id: playerId,
      socketId: socket.id
    };

    waitingQueue.push(player);
    playerSockets.set(playerId, socket);
    
    // Track this join for rate calculation
    recentJoins.push(Date.now());

    socket.emit('queue_joined', { 
      position: waitingQueue.length,
      queueSize: waitingQueue.length 
    });

    waitingQueue.forEach(p => {
      const playerSocket = playerSockets.get(p.id);
      if (playerSocket) {
        playerSocket.emit('queue_update', { queueSize: waitingQueue.length });
      }
    });

    // Use dynamic matchmaking instead of immediate start
    startDynamicMatchmaking();
  });

  socket.on('send_message', ({ gameId, message }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.CONVERSATION) return;

    const player = game.players.find(p => !p.isAI && playerSockets.get(p.id) === socket);
    if (!player) return;

    // Check if player is currently timed out
    const timeoutExpiry = playerTimeouts.get(player.id);
    if (timeoutExpiry && Date.now() < timeoutExpiry) {
      const remainingSeconds = Math.ceil((timeoutExpiry - Date.now()) / 1000);
      socket.emit('message_blocked', {
        reason: 'You are in timeout for using inappropriate language.',
        remainingSeconds
      });
      return;
    }

    // Check for inappropriate content
    if (containsInappropriateContent(message)) {
      // Set 10-second timeout
      const timeoutExpiry = Date.now() + 10000;
      playerTimeouts.set(player.id, timeoutExpiry);

      // Notify the player
      socket.emit('message_blocked', {
        reason: 'Your message contained inappropriate language. You cannot send messages for 10 seconds.',
        remainingSeconds: 10
      });

      // Auto-remove timeout after 10 seconds
      setTimeout(() => {
        playerTimeouts.delete(player.id);
      }, 10000);

      return;
    }

    const msg = {
      id: Date.now(),
      player: player.name,
      text: message.trim(),
      timestamp: Date.now()
    };

    game.messages.push(msg);
    io.to(gameId).emit('new_message', msg);
  });

  socket.on('cast_vote', ({ gameId, votedPlayer }) => {
    const game = games.get(gameId);
    if (!game || game.phase !== GAME_PHASES.VOTING) return;

    const player = game.players.find(p => !p.isAI && playerSockets.get(p.id) === socket);
    if (!player || game.votes[player.id]) return;

    game.votes[player.id] = votedPlayer;

    io.to(gameId).emit('vote_cast', { 
      voter: player.name,
      votesRemaining: game.players.filter(p => !p.isAI).length - Object.keys(game.votes).length
    });

    const humanPlayers = game.players.filter(p => !p.isAI);
    if (Object.keys(game.votes).length >= humanPlayers.length) {
      endGame(gameId);
    }
  });

  socket.on('leave_queue', () => {
    const index = waitingQueue.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      const player = waitingQueue[index];
      waitingQueue.splice(index, 1);
      playerSockets.delete(player.id);

      waitingQueue.forEach(p => {
        const playerSocket = playerSockets.get(p.id);
        if (playerSocket) {
          playerSocket.emit('queue_update', { queueSize: waitingQueue.length });
        }
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    const queueIndex = waitingQueue.findIndex(p => p.socketId === socket.id);
    if (queueIndex !== -1) {
      const player = waitingQueue[queueIndex];
      waitingQueue.splice(queueIndex, 1);
      playerSockets.delete(player.id);
    }

    games.forEach((game, gameId) => {
      const player = game.players.find(p => !p.isAI && playerSockets.get(p.id) === socket);
      if (player) {
        io.to(gameId).emit('player_disconnected', { playerName: player.name });
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 Turing Test Game Server running on port ${PORT}`);
});
