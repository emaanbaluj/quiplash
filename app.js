// app.js
'use strict';

// ===== Imports & Setup =====

// HTTP client for calling the Part 1 backend API
const axios = require('axios');

// Express web server
const express = require('express');
const app = express();

// HTTP server + Socket.IO for real-time game communication
const http = require('http');
const server = http.Server(app);
const io = require('socket.io')(server);

// Configure EJS templates and serve static files
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

// Main interactive client (player UI) route
app.get('/', (req, res) => {
  res.render('client');
});

// Display client (projector / spectator UI) route
app.get('/display', (req, res) => {
  res.render('display');
});

// URL of the Part 1 backend API (Azure Functions)
const BACKEND_ENDPOINT = process.env.BACKEND || 'http://localhost:8181';

// ===== In-Memory Game State =====
// Stores the current state of the game and all connected users.
const gameState = {
  stage: 'JOINING',     // JOINING, PROMPTS, ANSWERS, VOTING, SCORING, GAME_OVER
  round: 0,
  players: [],          // Active players in the game
  audience: [],         // Spectators
  activePrompts: [],    // Prompts currently being used in the round
};

// ===== Server Start =====

// Starts the Node/Express/Socket.IO server listening on the configured port.
function startServer() {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

// ===== Utility: Public State & Broadcasts =====

// Assigns active prompts to players, ensuring they don't answer their own prompts.
function assignPromptsToPlayers(players, prompts) {
  // Helper functions for shuffling and finding valid prompts omitted for brevity.
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  const shuffledPlayers = shuffle([...players]);
  const shuffledPrompts = shuffle([...prompts]);

  const assignments = new Map();
  players.forEach(p => assignments.set(p.username, []));

  let promptIndex = 0;

  function getNextValidPrompt(playerA, playerB) {
    for (let i = promptIndex; i < shuffledPrompts.length; i++) {
      const pr = shuffledPrompts[i];
      if (pr.author !== playerA.username && pr.author !== playerB.username) {
        [shuffledPrompts[i], shuffledPrompts[promptIndex]] =
          [shuffledPrompts[promptIndex], shuffledPrompts[i]];
        promptIndex++;
        return shuffledPrompts[promptIndex - 1];
      }
    }
    return null;
  }

  const playerCount = shuffledPlayers.length;
  const isEven = playerCount % 2 === 0;

  if (isEven) {
    for (let i = 0; i < playerCount; i += 2) {
      const p1 = shuffledPlayers[i];
      const p2 = shuffledPlayers[i + 1];

      const prompt = getNextValidPrompt(p1, p2);
      if (prompt) {
        assignments.get(p1.username).push(prompt);
        assignments.get(p2.username).push(prompt);
      }
    }
  } else {
    for (let i = 0; i < playerCount; i++) {
      const p1 = shuffledPlayers[i];
      const p2 = shuffledPlayers[(i + 1) % playerCount];

      const prompt = getNextValidPrompt(p1, p2);
      if (prompt) {
        assignments.get(p1.username).push(prompt);
        assignments.get(p2.username).push(prompt);
      }
    }
  }

  return assignments;
}

// Returns a public, filtered list of players for use in state updates.
function getPublicPlayers() {
  return gameState.players.map(p => ({
    id: p.id,
    username: p.username,
    score: p.score,
    isAdmin: p.isAdmin,
    status: p.state.status,
  }));
}

// Compiles and broadcasts the entire current game state to all connected clients.
function updateAll() {
  const publicPlayers = gameState.players.map(p => ({
    id: p.id,
    username: p.username,
    score: p.score,
    isAdmin: p.isAdmin,
    status: p.state.status,
    prompt: p.state.prompt,
    assignedPrompts: p.state.assignedPrompts,
    answers: p.state.answers,
    roundScore: p.state.roundScore || 0,
    votesCast: p.state.votesCast,
  }));

  // Calculates rank based on total score.
  const sorted = [...publicPlayers].sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  );
  sorted.forEach((p, idx) => {
    const original = publicPlayers.find(q => q.id === p.id);
    if (original) {
      original.rank = idx + 1;
    }
  });

  const publicAudience = gameState.audience.map(a => ({
    id: a.id,
    username: a.username,
    status: a.state.status,
  }));

  io.emit('gameState', {
    stage: gameState.stage,
    round: gameState.round,
    players: publicPlayers,
    audience: publicAudience,
    activePrompts: gameState.activePrompts,
  });
}

// Sends a standardized result object back to a single socket after an action.
function sendApiResult(socket, eventName, { result, msg, username, isAdmin }) {
  socket.emit(eventName, {
    result: result,
    msg,
    ...(username !== undefined ? { username } : {}),
    isAdmin: !!isAdmin,
  });
}

// ===== Backend API Helpers (Part 1) =====

// Generic helper to call the Part 1 backend API (Azure Functions).
async function callBackend(path, method = 'get', data = undefined) {
  const url = `${BACKEND_ENDPOINT}${path}`;

  try {
    const config = {
      url,
      method: method.toLowerCase(),
    };

    if (data !== undefined) {
      config.data = data;
    }

    const res = await axios(config);
    return res.data;
  } catch (err) {
    console.error(
      `Error calling backend ${method.toUpperCase()} ${path}:`,
      err.message
    );
    throw err;
  }
}

// Calls the backend to register a new player.
async function apiRegister(username, password) {
  return callBackend('/player/register', 'post', {
    username,
    password,
  });
}

// Calls the backend to log in and authenticate a player.
async function apiLogin(username, password) {
  return callBackend('/player/login', 'post', {
    username,
    password,
  });
}

// Calls the backend to store a new player-submitted prompt.
async function apiPromptCreate(username, text, tags = []) {
  return callBackend('/prompt/create', 'post', {
    text,
    username,
    tags,
  });
}

// Calls the backend to fetch existing prompts for round assembly (currently stubbed).
async function apiUtilsGet(usernames, tagList = []) {
  return callBackend('/utils/get', 'get', {
    players: usernames,
    tag_list: tagList,
  });
}

// Stub function for combining backend prompts and in-game prompts (WIP).
async function buildRoundPrompts() {
  const players = getPublicPlayers();
  const usernames = players.map(p => p.username);
  // TODO: use apiUtilsGet(usernames, ['comp3207-game']) and combine with in-game prompts
}

// ===== Player / Audience Management =====

// Finds a user (player or audience) in the game state by their socket ID.
function findUserBySocketId(socketId) {
  return (
    gameState.players.find(p => p.socketId === socketId) ||
    gameState.audience.find(a => a.socketId === socketId)
  );
}

// Adds a validated user as a player (if space/stage allows) or as an audience member.
function addPlayerOrAudience(socket, username) {
  // If the lobby is open and has space, add as a player.
  if (gameState.players.length < 4 && gameState.stage === 'JOINING') {
    const isAdmin = gameState.players.length === 0;

    const player = {
      id: socket.id,
      username,
      score: 0,
      isAdmin,
      socketId: socket.id,
      state: {
        status: 'JOINING',
        assignedPrompts: [],
        answers: {},
        votesCast: {},
        roundVotes: 0,
        roundScore: 0,
        prompt: null,
      },
    };

    gameState.players.push(player);
    console.log('Added player:', username, 'isAdmin:', isAdmin);

    updateAll();
    return player;
  } else {
    // Otherwise, add as an audience member/spectator.
    const audienceMember = {
      id: socket.id,
      username,
      socketId: socket.id,
      state: { status: 'AUDIENCE' },
    };

    gameState.audience.push(audienceMember);
    console.log('Added audience member:', username);

    updateAll();
    return audienceMember;
  }
}

// ===== Chat Handling =====

// Receives a chat message from a socket and broadcasts it to all clients.
function handleChat(socket, message) {
  const user = findUserBySocketId(socket.id);

  const username =
    (user && user.username) ||
    (message && typeof message === 'object' && message.username) ||
    'Unknown';

  const text =
    typeof message === 'string'
      ? message
      : (message && message.text) || '';

  const messageObj = {
    username,
    text,
  };

  console.log('Handling chat from', username, ':', text);
  io.emit('chat', messageObj);
}

// ===== Auth Handling (Register / Login) =====

// Handles a player registration request by calling the backend API.
async function handleRegister(socket, data) {
  try {
    const result = await apiRegister(data.username, data.password);

    sendApiResult(socket, 'registerResult', {
      result: result.result,
      msg: result.msg,
      username: data.username,
      isAdmin: false,
    });
  } catch (err) {
    console.error('Register error:', err.message);
    sendApiResult(socket, 'registerResult', {
      result: false,
      msg: 'Server error while registering',
      username: data?.username,
      isAdmin: false,
    });
  }
}

// Handles a player login request, validates credentials, and adds the user to the game state.
async function handleLogin(socket, data) {
  try {
    const result = await apiLogin(data.username, data.password);

    let userObj = null;
    if (result.result) {
      userObj = addPlayerOrAudience(socket, data.username);
    }

    sendApiResult(socket, 'loginResult', {
      result: result.result,
      msg: result.msg,
      username: data.username,
      isAdmin: userObj ? !!userObj.isAdmin : false,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    sendApiResult(socket, 'loginResult', {
      result: false,
      msg: 'Server error while logging in',
      isAdmin: false,
    });
  }
}

// ===== Game Flow Helpers =====

// Checks if every player has submitted a prompt.
function allPromptsSubmitted() {
  if (!gameState.players.length) return false;
  return gameState.players.every(
    p => p.state && p.state.status === 'PROMPT_SUBMITTED'
  );
}

// Checks if every player has submitted an answer for all their assigned prompts.
function allAnswersSubmitted() {
  if (!gameState.players.length) return false;
  return gameState.players.every(p => {
    const assigned = p.state.assignedPrompts || [];
    if (!assigned.length) return false;
    return assigned.every(pr =>
      Object.prototype.hasOwnProperty.call(p.state.answers || {}, pr.id)
    );
  });
}

// Checks if every player has submitted vote for every single answer

// Checks if every player has submitted vote for every single answer
function allVotesSubmitted(){
  if (!gameState.players.length || !gameState.activePrompts.length) return false;

  const totalPromptsToVoteOn = gameState.activePrompts.length;


  return gameState.players.every(p => {
    const votesCast = p.state.votesCast || {};

    return Object.keys(votesCast).length === totalPromptsToVoteOn;
  });
}

// -----------------------------
// startPromptStage()
// -----------------------------
// Resets player state and advances the game stage to PROMPTS, starting a new round.
function startPromptStage() {
  console.log('Starting PROMPT stage');

  gameState.stage = 'PROMPTS';
  gameState.round += 1;

  gameState.players.forEach(p => {
    p.state.status = 'WAITING_FOR_PROMPTS';
    p.state.prompt = null;
    p.state.assignedPrompts = [];
    p.state.answers = {};
    p.state.votesCast = {};
    p.state.roundVotes = 0;
    p.state.roundScore = 0;
   
  });

  gameState.audience.forEach(a => {
    a.state.status = 'AUDIENCE_WAITING';
  });

  gameState.activePrompts = [];
  updateAll();
}

// -----------------------------
// startAnswerStage()
// -----------------------------
// Aggregates submitted prompts, assigns them to players, and moves to the ANSWERS stage.
function startAnswerStage() {
  console.log('Starting ANSWER stage');

  const prompts = gameState.players
    .filter(p => p.state.prompt)
    .map((p, index) => ({
      id: index,
      text: p.state.prompt,
      author: p.username,
    }));

  if (prompts.length === 0) {
    console.log('No prompts found, cannot start answer stage.');
    return;
  }

  gameState.activePrompts = prompts;

  const assignments = assignPromptsToPlayers(gameState.players, prompts);

  gameState.players.forEach(player => {
    const myPrompts = assignments.get(player.username) || [];
    player.state.assignedPrompts = myPrompts;
    player.state.status = 'WAITING_FOR_ANSWERS';
    player.state.answers = {};
  });

  gameState.stage = 'ANSWERS';
  updateAll();
}

// -----------------------------
// startVotingStage()
// -----------------------------
// Changes the game stage to VOTING so players can cast votes on answers.
function startVotingStage() {
  console.log('Starting VOTING stage');

  gameState.stage = 'VOTING';

  gameState.players.forEach(p => {
    p.state.status = 'WAITING_FOR_VOTES';
    p.state.votesCast = p.state.votesCast || {};
    p.state.roundVotes = p.state.roundVotes || 0;
  });

  updateAll();
}

// -----------------------------
// endVotingAndScoreRound()
// -----------------------------
// Calculates player scores based on votes received and updates the total score.
function endVotingAndScoreRound() {
  console.log('Ending voting and computing round scores');

  gameState.players.forEach(p => {
    const votes = p.state.roundVotes || 0;
    // Points calculation: round number * votes * 100
    const points = gameState.round * votes * 100;

    p.state.roundScore = points;

    if (typeof p.score !== 'number') {
      p.score = 0;
    }
    p.score += points;
  });

  gameState.stage = 'SCORING';
  updateAll();
}

// ===== Start Game (JOINING → PROMPTS) =====

// Handles the host's request to start the game from the JOINING stage.
async function handleStartGame(socket) {
  const user = findUserBySocketId(socket.id);
  if (!user || !user.isAdmin) {
    socket.emit('nextResult', {
      result: false,
      msg: 'Only the admin can start the game.',
    });
    return;
  }

  if (gameState.stage === 'JOINING') {
    startPromptStage();
    socket.emit('nextResult', {
      result: true,
      msg: 'Game has started! Moving to prompt stage.',
    });
  }
}

// ===== Advance Game (PROMPTS → ANSWERS → VOTING → SCORING → next round / GAME_OVER) =====

// Manages the flow of the game between stages, triggered only by the host.
// app.js (updated handleAdvanceGame)

// ... (other functions)

// Manages the flow of the game between stages, triggered only by the host.
function handleAdvanceGame(socket) {
  const user = findUserBySocketId(socket.id);

  if (!user || !user.isAdmin) {
    socket.emit('nextResult', {
      result: false,
      msg: 'Only the admin can advance the game.',
    });
    return;
  }

  // PROMPTS → ANSWERS: Checks if all prompts are submitted before advancing.
  if (gameState.stage === 'PROMPTS') {
    if (!allPromptsSubmitted()) {
      socket.emit('nextResult', {
        result: false,
        msg: 'Not all players have submitted a prompt.',
      });
      return;
    }
    startAnswerStage();
    socket.emit('nextResult', {
      result: true,
      msg: 'Moving to ANSWERS stage.',
    });
    return;
  }

  // ANSWERS → VOTING: Checks if all answers are submitted before advancing.
  if (gameState.stage === 'ANSWERS') {
    if (!allAnswersSubmitted()) {
      socket.emit('nextResult', {
        result: false,
        msg: 'Not all answers have been submitted.',
      });
      return;
    }
    startVotingStage();
    socket.emit('nextResult', {
      result: true,
      msg: 'Moving to VOTING stage.',
    });
    return;
  }

  // VOTING → SCORING: Checks if all votes are submitted and computes scores.
  if (gameState.stage === 'VOTING') {
    if (!allVotesSubmitted()) {
      socket.emit('nextResult', {
        result: false,
        msg: 'Not all players have cast their votes yet.',
      });
      return;
    }
    endVotingAndScoreRound();
    socket.emit('nextResult', {
      result: true,
      msg: 'Voting finished. Showing scores.',
    });
    return;
  }

  // SCORING → next round OR GAME_OVER: Checks if max rounds (3) is reached.
  if (gameState.stage === 'SCORING') {
    if (gameState.round >= 3) {
      gameState.stage = 'GAME_OVER';
      updateAll();
      socket.emit('nextResult', {
        result: true,
        msg: 'All 3 rounds complete. Game over!',
      });
    } else {
      startPromptStage();
      socket.emit('nextResult', {
        result: true,
        msg: `Starting round ${gameState.round}.`,
      });
    }
    return;
  }

  socket.emit('nextResult', {
    result: false,
    msg: `Advance not implemented for ${gameState.stage}`,
  });
}

// ===== Prompt Handling =====

// Handles a player's prompt submission, validates it, and saves it via the backend API.
async function handlePrompt(socket, data) {
  const user = findUserBySocketId(socket.id);

  if (!user || gameState.stage !== 'PROMPTS' || user.state.status === 'PROMPT_SUBMITTED') {
    socket.emit('promptResult', { result: false, msg: 'Cannot submit prompt now or already submitted.' });
    return;
  }

  const text = (data.text || '').trim();
  if (!text || text.length < 20 || text.length > 120) {
    socket.emit('promptResult', { result: false, msg: 'Prompt must be 20–120 characters.' });
    return;
  }

  try {
    const result = await apiPromptCreate(user.username, text, ['comp3207-game']);
    if (!result.result) {
      socket.emit('promptResult', { result: false, msg: result.msg });
      return;
    }

    user.state.prompt = text;
    user.state.status = 'PROMPT_SUBMITTED';

    socket.emit('promptResult', { result: true, msg: result.msg });
    updateAll();

  } catch (err) {
    socket.emit('promptResult', { result: false, msg: 'Server error submitting prompt.' });
  }
}

// ===== Answer Handling =====

// Handles a player's answer submission for an assigned prompt.
async function handleAnswer(socket, data) {
  const user = findUserBySocketId(socket.id);
  if (!user || gameState.stage !== 'ANSWERS' || !data || !data.text || data.promptId === undefined) {
    socket.emit('answerResult', { result: false, msg: 'Invalid answer or not the answer stage.' });
    return;
  }

  const promptId = data.promptId;
  const text = data.text.trim();

  user.state.answers = user.state.answers || {};
  user.state.answers[promptId] = text;

  // Check if all assigned prompts have been answered by this player.
  const myAssigned = user.state.assignedPrompts || [];
  const allAnswered =
    myAssigned.length > 0 &&
    myAssigned.every(pr =>
      Object.prototype.hasOwnProperty.call(user.state.answers, pr.id)
    );

  if (allAnswered) {
    user.state.status = 'ANSWER_SUBMITTED';
  }

  socket.emit('answerResult', { result: true, msg: 'Answer submitted!' });
  updateAll();

  if (allAnswersSubmitted()) {
    io.emit('allAnswersReady'); // Notify display/host that answers are complete
  }
}

// ===== Voting Handling =====

// Handles a player's vote for an answer, ensuring they don't vote for themselves or multiple times.
function handleVote(socket, data) {
  const user = findUserBySocketId(socket.id);
  if (!user || gameState.stage !== 'VOTING' || !data || data.promptId === undefined) {
    socket.emit('voteResult', { result: false, msg: 'Invalid vote or not in voting stage.' });
    return;
  }

  const promptId = data.promptId;
  const targetUsername = data.targetUsername || data.answerId;

  const targetPlayer = gameState.players.find(p => p.username === targetUsername);
  if (!targetPlayer || targetPlayer.username === user.username) {
    socket.emit('voteResult', { result: false, msg: 'Cannot vote for yourself or invalid target.' });
    return;
  }

  user.state.votesCast = user.state.votesCast || {};
  if (user.state.votesCast[promptId]) {
    socket.emit('voteResult', { result: false, msg: 'You already voted on this prompt.' });
    return;
  }

  // Record vote and increment target's vote count
  user.state.votesCast[promptId] = targetPlayer.username;
  targetPlayer.state.roundVotes = (targetPlayer.state.roundVotes || 0) + 1;

  socket.emit('voteResult', { result: true, msg: 'Vote recorded.' });
  updateAll();
}

// ===== Socket.IO Wiring =====

// Sets up handlers for incoming socket events (chat, login, game actions, etc.).
io.on('connection', socket => {
  console.log('New connection:', socket.id);

  updateAll(); // Send initial state to the new client

  socket.on('chat', msg => handleChat(socket, msg));
  socket.on('register', data => handleRegister(socket, data));
  socket.on('login', data => handleLogin(socket, data));
  socket.on('prompt', data => handlePrompt(socket, data));
  socket.on('answer', data => handleAnswer(socket, data));
  socket.on('vote', data => handleVote(socket, data));

  // Handles 'next' button click from the host to start or advance the game.
  socket.on('next', () => {
    if (gameState.stage === 'JOINING') {
      handleStartGame(socket);
    } else {
      handleAdvanceGame(socket);
    }
  });

  // Handles client disconnection by removing the user from the game state.
  socket.on('disconnect', () => {
    console.log('Dropped connection:', socket.id);

    gameState.players = gameState.players.filter(p => p.socketId !== socket.id);
    gameState.audience = gameState.audience.filter(a => a.socketId !== socket.id);

    updateAll(); // Broadcast state change
  });
});

// ===== Start Server =====

if (module === require.main) {
  startServer();
}

module.exports = server;