'use strict';

//Set up express
const express = require('express');
const app = express();

//Setup socket.io
const server = require('http').Server(app);
const io = require('socket.io')(server);

//Setup static page handling
app.set('view engine', 'ejs');
app.use('/static', express.static('public'));

//Handle client interface on /
app.get('/', (req, res) => {
  res.render('client');
});

//Handle display interface on /display
app.get('/display', (req, res) => {
  res.render('display');
});

// URL of the backend API
const BACKEND_ENDPOINT = process.env.BACKEND || 'http://localhost:8181';

//Start the server
function startServer() {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

//Chat message
function handleChat(message) {
    console.log('Handling chat: ' + message); 
    io.emit('chat',message);
}

const gameState = {
  stage: 'JOINING',  // JOINING, PROMPTS, ANSWERS, VOTING, RESULTS, SCORES, GAME_OVER
  round: 1, 
  players: [], // { id, username, score, isAdmin, socketId }
  audience: [], // { id, username, socketId }
}

function addPlayerOrAudience(socket, username){

  if (gameState.players.length < 8 && gameState.stage == 'JOINING'){

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
          roundScore: 0,
        },
      }

      gameState.players.push(player)
  }


  else {
    const audienceMember = {
      id: socket.id,
      username,
      socketId: socket.id,
      state: { status: 'AUDIENCE' },
  };

  gameState.audience.push(audienceMember)
  }
}





//Handle new connection
io.on('connection', socket => { 
  console.log('New connection');

  //Handle on chat message received
  socket.on('chat', message => {
    handleChat(message);
  });

  //Handle disconnection
  socket.on('disconnect', () => {
    console.log('Dropped connection');
  });
});



//Start server
if (module === require.main) {
  startServer();
}

module.exports = server;
