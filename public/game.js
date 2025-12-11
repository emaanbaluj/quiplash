// public/client.js

var socket = null;

var app = new Vue({
  el: '#game',
  data: {
    connected: false,

    // chat
    messages: [],         // { username, text }
    chatmessage: '',

    // auth
    loggedIn: false,
    isAdmin: false,
    username: '',
    password: '',

    // game-specific fields
    promptText: '',
    answerText: '',          // legacy single-answer field (no longer used)
    selectedAnswerId: null,

    // NEW: per-prompt answer drafts { [promptId]: "text" }
    answersDraft: {},

    // state from server
    gameState: null,
    lobbyPlayers: [],
    lobbyAudience: [],

    // global error/info line
    errorMessage: '',
    isPositiveMessage: true, // Controls the color class (true = green, false = red)
  },

  mounted: function () {
    connect();
  },

  computed: {
    // Convenience: find THIS player in gameState.players
    myPlayer() {
      if (!this.gameState || !this.gameState.players) return null;
      return this.gameState.players.find(p => p.username === this.username) || null;
    },

    debugState() {
      return JSON.stringify(this.gameState, null, 2);
    }
  },

  methods: {
    // ===== chat =====
    handleChat(message) {
      console.log('[CLIENT] handleChat():', message);

      // keep at most 20 messages
      if (this.messages.length >= 20) {
        this.messages.pop();
      }
      this.messages.unshift(message);
    },

    chat() {
      if (!this.chatmessage || !this.chatmessage.trim()) return;

      const msg = {
        username: this.username,
        text: this.chatmessage,
      };

      console.log('[CLIENT] emit chat:', msg);
      socket.emit('chat', msg);
      this.chatmessage = '';
    },

    // ===== auth =====
    register() {
      console.log('[CLIENT] emit register:', {
        username: this.username,
        password: this.password,
      });
      socket.emit('register', {
        username: this.username,
        password: this.password,
      });
    },

    login() {
      console.log('[CLIENT] emit login:', {
        username: this.username,
        password: this.password,
      });
      socket.emit('login', {
        username: this.username,
        password: this.password,
      });
    },

    // ===== prompts & answers =====
    submitPrompt() {
      console.log('[CLIENT] emit prompt:', { text: this.promptText });
      socket.emit('prompt', { text: this.promptText });
      // we clear promptText when server confirms promptResult
    },

    // UPDATED: use per-prompt drafts instead of single answerText
    submitAnswer(promptId) {
      const text = this.answersDraft[promptId];

      console.log('[CLIENT] submitAnswer for prompt', promptId, 'text =', text);

      if (!text || !text.trim()) {
        // nothing typed – don't send
        return;
      }

      console.log('[CLIENT] emit answer:', {
        promptId: promptId,
        text: text,
      });

      socket.emit('answer', {
        promptId: promptId,
        text: text,
      });

      // optional: clear the draft locally after sending
      // this.answersDraft = { ...this.answersDraft, [promptId]: '' };
    },

    castVote(promptId, answerId) {
      console.log('[CLIENT] emit vote:', {
        promptId: promptId,
        answerId: answerId,
      });
      socket.emit('vote', {
        promptId: promptId,
        answerId: answerId,
      });
    },

    // ===== admin next =====
    next() {
      if (!this.isAdmin) return;
      console.log('[CLIENT] emit next');
      socket.emit('next');
    },
  },
});

// ===== socket.io wiring =====
function connect() {
  console.log('[CLIENT] connecting to socket.io…');
  socket = io();

  socket.on('connect', function () {
    console.log('[CLIENT] connected, socket.id =', socket.id);
    app.connected = true;
    app.errorMessage = '';
    app.isPositiveMessage = true; 
  });

  socket.on('connect_error', function (err) {
    console.log('[CLIENT] connect_error:', err);
    app.errorMessage = 'Unable to connect to server.';
    app.connected = false;
    app.isPositiveMessage = false; 
  });

  socket.on('disconnect', function (reason) {
    console.log('[CLIENT] disconnected, reason =', reason);
    app.connected = false;
    app.loggedIn = false;
    app.isAdmin = false;
    app.errorMessage = 'Disconnected from server.';
    app.isPositiveMessage = false; 
  });

  // chat from server
  socket.on('chat', function (message) {
    console.log('[CLIENT] received chat:', message);
    app.handleChat(message);
  });

  // full game state from server
  socket.on('gameState', function (state) {
    console.log('[CLIENT] gameState:', state);
    app.gameState = state || {};
    app.lobbyPlayers = (state && state.players) || [];
    app.lobbyAudience = (state && state.audience) || [];
  });

  // login result
  socket.on('loginResult', function (res) {
    console.log('[CLIENT] loginResult:', res);

    if (res.result) {
      app.loggedIn = true;
      app.errorMessage = '';
      app.isPositiveMessage = true; 
      app.username = res.username || app.username;
      app.isAdmin = !!res.isAdmin;
    } else {
      app.loggedIn = false;
      app.isAdmin = false;
      app.errorMessage = 'Login failed: ' + (res.msg || 'Unknown error');
      app.isPositiveMessage = false; 
    }
  });

  // register result
  socket.on('registerResult', function (res) {
    console.log('[CLIENT] registerResult:', res);

    if (res.result) {
      app.errorMessage = 'Registered OK: ' + (res.msg || '');
      app.isPositiveMessage = true; 
    } else {
      app.errorMessage = 'Registration failed: ' + (res.msg || 'Unknown error');
      app.isPositiveMessage = false; 
    }
  });

  // prompt submission result
  socket.on('promptResult', function (res) {
    console.log('[CLIENT] promptResult:', res);

    if (res.result) {
      app.promptText = '';
      app.errorMessage = res.msg || 'Prompt submitted!';
      app.isPositiveMessage = true; 
    } else {
      app.errorMessage = res.msg || 'Prompt failed.';
      app.isPositiveMessage = false; 
    }
  });

  // answer submission result
  socket.on('answerResult', function (res) {
    console.log('[CLIENT] answerResult:', res);

    if (res.result) {
      // we still clear the legacy field; harmless
      app.answerText = '';
      app.errorMessage = res.msg || 'Answer submitted!';
      app.isPositiveMessage = true; 
    } else {
      app.errorMessage = res.msg || 'Answer failed.';
      app.isPositiveMessage = false; 
    }
  });

  // NEW: vote result
  socket.on('voteResult', function (res) {
    console.log('[CLIENT] voteResult:', res);

    if (res.result) {
      app.errorMessage = res.msg || 'Vote cast!';
      app.isPositiveMessage = true;

      // CRITICAL FIX: If the vote succeeded, update the local player state
      // This forces the UI to refresh, disabling buttons and showing (Voted)
      if (app.myPlayer && res.promptId !== undefined) {
          if (!app.myPlayer.votesCast) {
              app.myPlayer.votesCast = {};
          }
          // Use Vue.set for reactivity when adding a new property to an object
          // This assumes the server's res includes 'promptId'
          Vue.set(app.myPlayer.votesCast, res.promptId, res.answerId || 'voted');
      }

    } else {
      app.errorMessage = res.msg || 'Voting failed.';
      app.isPositiveMessage = false;
    }
  });

  // admin next / advance result
  socket.on('nextResult', function (res) {
    console.log('[CLIENT] nextResult:', res);

    if (res.result) {
      app.errorMessage = '';
      app.isPositiveMessage = true; 
    } else {
      app.errorMessage = res.msg || 'Error advancing game';
      app.isPositiveMessage = false; 
    }
  });
}