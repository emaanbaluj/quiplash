// app.js
'use strict';

// ===== Imports & Setup =====

// HTTP client for calling the Part 1 backend API (/player, /prompt, /utils, etc.)
const axios = require('axios');

// Express web server
const express = require('express');
const app = express();

// HTTP server + Socket.IO for real-time game communication
const http = require('http');
const server = http.Server(app);
const io = require('socket.io')(server);

// Use EJS templates and serve static files from /public
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

// Main interactive client (player UI)
app.get('/', (req, res) => {
  res.render('client');
});

// Display client (projector / spectator UI)
app.get('/display', (req, res) => {
  res.render('display');
});

// URL of the Part 1 backend API (your Azure Functions)
const BACKEND_ENDPOINT = process.env.BACKEND || 'http://localhost:8181';

// ===== In-Memory Game State =====
// This lives only in the Node server (reset when server restarts)
const gameState = {
  stage: 'JOINING',     // JOINING, PROMPTS, ANSWERS, VOTING, SCORING, GAME_OVER
  round: 0,
  players: [],          // { id, username, score, isAdmin, socketId, state: {...} }
  audience: [],         // { id, username, socketId, state: {...} }
  activePrompts: [],    // prompts used in current round (filled after PROMPTS)
};

// ===== Server Start =====

// Starts the Node/Express/Socket.IO server
function startServer() {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

// ===== Utility: Public State & Broadcasts =====

function assignPromptsToPlayers(players, prompts) {
  // 1. Shuffle helper
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 2. Prepare data
  const shuffledPlayers = shuffle([...players]);
  const shuffledPrompts = shuffle([...prompts]);

  const assignments = new Map();
  players.forEach(p => assignments.set(p.username, []));

  // Helper to find a valid prompt (one that neither player wrote)
  let promptIndex = 0;

  function getNextValidPrompt(playerA, playerB) {
    for (let i = promptIndex; i < shuffledPrompts.length; i++) {
      const pr = shuffledPrompts[i];
      if (pr.author !== playerA.username && pr.author !== playerB.username) {
        // swap to the front so we don't reuse it
        [shuffledPrompts[i], shuffledPrompts[promptIndex]] =
          [shuffledPrompts[promptIndex], shuffledPrompts[i]];
        promptIndex++;
        return shuffledPrompts[promptIndex - 1];
      }
    }
    return null; // not enough valid prompts
  }

  const playerCount = shuffledPlayers.length;
  const isEven = playerCount % 2 === 0;

  if (isEven) {
    // EVEN: pair players (0,1), (2,3), ... each pair gets ONE shared prompt
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
    // ODD: circular pairs (0,1), (1,2), ..., (last,0) – players can end up with 2 prompts
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

// Returns public view of players (no private fields like socketId)
function getPublicPlayers() {
  return gameState.players.map(p => ({
    id: p.id,
    username: p.username,
    score: p.score,
    isAdmin: p.isAdmin,
    status: p.state.status,
  }));
}

// Broadcasts the current gameState to all connected sockets
function updateAll() {
  // base player info
  const publicPlayers = gameState.players.map(p => ({
    id: p.id,
    username: p.username,
    score: p.score,                    // total score
    isAdmin: p.isAdmin,
    status: p.state.status,
    prompt: p.state.prompt,
    assignedPrompts: p.state.assignedPrompts,
    answers: p.state.answers,
    roundScore: p.state.roundScore || 0, // per-round score (for UI)
  }));

  // add rank based on total score (1 = best)
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

// Sends a standardised result object back to a single socket
function sendApiResult(socket, eventName, { result, msg, username, isAdmin }) {
  socket.emit(eventName, {
    result: result,
    msg,
    ...(username !== undefined ? { username } : {}),
    isAdmin: !!isAdmin,
  });
}

// ===== Backend API Helpers (Part 1) =====

// Generic helper to call Part 1 backend with axios
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

// Calls Part 1 /player/register to create a new player
async function apiRegister(username, password) {
  return callBackend('/player/register', 'post', {
    username,
    password,
  });
}

// Calls Part 1 /player/login to validate username/password
async function apiLogin(username, password) {
  return callBackend('/player/login', 'post', {
    username,
    password,
  });
}

// Calls Part 1 /prompt/create to store a new prompt in Cosmos
async function apiPromptCreate(username, text, tags = []) {
  return callBackend('/prompt/create', 'post', {
    text,
    username,
    tags,
  });
}

// Calls Part 1 /utils/get to fetch prompts by players and tags
async function apiUtilsGet(usernames, tagList = []) {
  return callBackend('/utils/get', 'get', {
    players: usernames,
    tag_list: tagList,
  });
}

// Stub that will eventually build 50% API prompts + 50% in-game prompts
async function buildRoundPrompts() {
  const players = getPublicPlayers();
  const usernames = players.map(p => p.username);
  // TODO: use apiUtilsGet(usernames, ['comp3207-game']) and combine with in-game prompts
}

// ===== Player / Audience Management =====

function findUserBySocketId(socketId) {
  return (
    gameState.players.find(p => p.socketId === socketId) ||
    gameState.audience.find(a => a.socketId === socketId)
  );
}

function addPlayerOrAudience(socket, username) {
  if (gameState.players.length < 8 && gameState.stage === 'JOINING') {
    const isAdmin = gameState.players.length === 0; // first player is admin

    const player = {
      id: socket.id,
      username,
      score: 0,              // total score (across rounds)
      isAdmin,
      socketId: socket.id,
      state: {
        status: 'JOINING',
        assignedPrompts: [],
        answers: {},
        votesCast: {},
        roundVotes: 0,       // votes this round
        roundScore: 0,       // per-round score
        prompt: null,
      },
    };

    gameState.players.push(player);
    console.log('Added player:', username, 'isAdmin:', isAdmin);

    updateAll();
    return player;
  } else {
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

async function handleRegister(socket, data) {
  console.log('handleRegister: from socket', socket.id, 'data:', data);
  try {
    const result = await apiRegister(data.username, data.password);
    console.log('Register result from backend:', result);

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

async function handleLogin(socket, data) {
  console.log('handleLogin: from socket', socket.id, 'data:', data);
  try {
    const result = await apiLogin(data.username, data.password);
    console.log('Login result from backend:', result);

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

function allPromptsSubmitted() {
  if (!gameState.players.length) return false;
  return gameState.players.every(
    p => p.state && p.state.status === 'PROMPT_SUBMITTED'
  );
}

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

// -----------------------------
// startPromptStage()
// -----------------------------
function startPromptStage() {
  console.log('Starting PROMPT stage');

  gameState.stage = 'PROMPTS';
  gameState.round += 1;          // round 1,2,3,...

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
function endVotingAndScoreRound() {
  console.log('Ending voting and computing round scores');

  gameState.players.forEach(p => {
    const votes = p.state.roundVotes || 0;
    const points = gameState.round * votes * 100;

    p.state.roundScore = points;

    if (typeof p.score !== 'number') {
      p.score = 0;
    }
    // accumulate total score across rounds
    p.score += points;
  });

  gameState.stage = 'SCORING';
  updateAll();
}

// ===== Start Game (JOINING → PROMPTS) =====

async function handleStartGame(socket) {
  console.log('Start game requested by', socket.id);
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

function handleAdvanceGame(socket) {
  const user = findUserBySocketId(socket.id);

  if (!user || !user.isAdmin) {
    socket.emit('nextResult', {
      result: false,
      msg: 'Only the admin can advance the game.',
    });
    return;
  }

  console.log('handleAdvanceGame at stage:', gameState.stage);

  // PROMPTS → ANSWERS
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

  // ANSWERS → VOTING
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

  // VOTING → SCORING (end of voting for the round)
  if (gameState.stage === 'VOTING') {
    endVotingAndScoreRound();

    socket.emit('nextResult', {
      result: true,
      msg: 'Voting finished. Showing scores.',
    });
    return;
  }

  // SCORING → next round OR GAME_OVER
  if (gameState.stage === 'SCORING') {
    if (gameState.round >= 3) {
      // after 3 rounds, game over – leaderboard is final
      gameState.stage = 'GAME_OVER';
      updateAll();

      socket.emit('nextResult', {
        result: true,
        msg: 'All 3 rounds complete. Game over!',
      });
    } else {
      // start another round of prompts
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

async function handlePrompt(socket, data) {
  console.log('handlePrompt:', data);
  const user = findUserBySocketId(socket.id);

  if (!user) {
    socket.emit('promptResult', { result: false, msg: 'You are not in the game.' });
    return;
  }

  if (gameState.stage !== 'PROMPTS') {
    socket.emit('promptResult', { result: false, msg: `Cannot submit prompts during ${gameState.stage}` });
    return;
  }

  if (user.state.status === 'PROMPT_SUBMITTED') {
    socket.emit('promptResult', { result: false, msg: 'You already submitted a prompt.' });
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

async function handleAnswer(socket, data) {
  const user = findUserBySocketId(socket.id);
  if (!user) {
    socket.emit('answerResult', { result: false, msg: 'You are not in the game.' });
    return;
  }

  if (gameState.stage !== 'ANSWERS') {
    socket.emit('answerResult', { result: false, msg: 'Not answer stage.' });
    return;
  }

  if (
    !data ||
    typeof data.text !== 'string' ||
    !data.text.trim() ||
    data.promptId === undefined ||
    data.promptId === null
  ) {
    socket.emit('answerResult', { result: false, msg: 'Invalid answer.' });
    return;
  }

  const promptId = data.promptId;
  const text = data.text.trim();

  if (!user.state.answers) {
    user.state.answers = {};
  }
  user.state.answers[promptId] = text;

  const myAssigned = user.state.assignedPrompts || [];
  const allAnswered =
    myAssigned.length > 0 &&
    myAssigned.every(pr =>
      Object.prototype.hasOwnProperty.call(user.state.answers, pr.id)
    );

  if (allAnswered) {
    user.state.status = 'ANSWER_SUBMITTED';
  }

  console.log(`Answer from ${user.username} for prompt ${promptId}:`, text);

  socket.emit('answerResult', { result: true, msg: 'Answer submitted!' });
  updateAll();

  if (allAnswersSubmitted()) {
    console.log('All answers in!');
    io.emit('allAnswersReady');
  }
}

// ===== Voting Handling =====

function handleVote(socket, data) {
  const user = findUserBySocketId(socket.id); // voter
  if (!user) {
    socket.emit('voteResult', { result: false, msg: 'You are not in the game.' });
    return;
  }

  if (gameState.stage !== 'VOTING') {
    socket.emit('voteResult', { result: false, msg: 'Not in voting stage.' });
    return;
  }

  if (
    !data ||
    typeof data.promptId !== 'number' ||
    (!data.targetUsername && !data.answerId)
  ) {
    socket.emit('voteResult', { result: false, msg: 'Invalid vote.' });
    return;
  }

  const promptId = data.promptId;
  const targetUsername = data.targetUsername || data.answerId;

  const targetPlayer = gameState.players.find(p => p.username === targetUsername);
  if (!targetPlayer) {
    socket.emit('voteResult', { result: false, msg: 'Target player not found.' });
    return;
  }

  if (targetPlayer.username === user.username) {
    socket.emit('voteResult', { result: false, msg: 'You cannot vote for your own answer.' });
    return;
  }

  if (!user.state.votesCast) {
    user.state.votesCast = {};
  }
  if (user.state.votesCast[promptId]) {
    socket.emit('voteResult', { result: false, msg: 'You already voted on this prompt.' });
    return;
  }

  user.state.votesCast[promptId] = targetPlayer.username;

  if (!targetPlayer.state.roundVotes) {
    targetPlayer.state.roundVotes = 0;
  }
  targetPlayer.state.roundVotes += 1;

  console.log(`Vote: ${user.username} -> ${targetPlayer.username} on prompt ${promptId}`);

  socket.emit('voteResult', { result: true, msg: 'Vote recorded.' });
  updateAll();
}

// ===== Socket.IO Wiring =====

io.on('connection', socket => {
  console.log('New connection:', socket.id);

  updateAll();

  socket.on('chat', msg => handleChat(socket, msg));
  socket.on('register', data => handleRegister(socket, data));
  socket.on('login', data => handleLogin(socket, data));
  socket.on('prompt', data => handlePrompt(socket, data));
  socket.on('answer', data => handleAnswer(socket, data));
  socket.on('vote', data => handleVote(socket, data));

  socket.on('next', () => {
    if (gameState.stage === 'JOINING') {
      handleStartGame(socket);
    } else {
      handleAdvanceGame(socket);
    }
  });

  socket.on('disconnect', () => {
    console.log('Dropped connection:', socket.id);

    gameState.players = gameState.players.filter(p => p.socketId !== socket.id);
    gameState.audience = gameState.audience.filter(a => a.socketId !== socket.id);

    updateAll();
  });
});

// ===== Start Server =====

if (module === require.main) {
  startServer();
}

module.exports = server;
