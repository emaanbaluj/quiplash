var socket = null;

// Prepare game
var app = new Vue({
    el: '#game',
    data: {
        connected: false,
        messages: [],
        chatmessage: '',

        loggedIn: false,

        username: '',
        password: '',

        // extra fields for game actions
        promptText: '',          // new prompt you type
        answerText: '',          // the answer you type
        selectedAnswerId: null,  // which answer you vote for
    },
    mounted: function() {
        connect(); 
    },

    // Receives from views then emit to server
    methods: {
        handleChat(message) {
            console.log('[CLIENT] handleChat():', message);
            if (this.messages.length + 1 > 10) {
                this.messages.pop();
            }
            this.messages.unshift(message);
        },

        chat() {
            console.log('[CLIENT] emit chat:', this.chatmessage);
            socket.emit('chat', this.chatmessage);
            this.chatmessage = '';
        },

        // -------- AUTH / JOINING --------
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

        // -------- GAME ACTIONS --------
        submitPrompt() {
            console.log('[CLIENT] emit prompt:', {
                text: this.promptText,
            });
            socket.emit('prompt', {
                text: this.promptText,
            });
            this.promptText = '';
        },

        submitAnswer(promptId) {
            console.log('[CLIENT] emit answer:', {
                promptId: promptId,
                text: this.answerText,
            });
            socket.emit('answer', {
                promptId: promptId,
                text: this.answerText,
            });
            this.answerText = '';
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

        next() {
            console.log('[CLIENT] emit next');
            socket.emit('next');
        },
    }
});

function connect() {
    console.log('[CLIENT] connecting to socket.io…');
    socket = io();

    socket.on('connect', function() {
        console.log('[CLIENT] connected, socket.id =', socket.id);
        app.connected = true;
    });

    socket.on('connect_error', function(err) {
        console.log('[CLIENT] connect_error:', err);
        alert('Unable to connect: ' + err);
    });

    socket.on('disconnect', function(reason) {
        console.log('[CLIENT] disconnected, reason =', reason);
        app.connected = false;
    });

    // incoming chat
    socket.on('chat', function(message) {
        console.log('[CLIENT] received chat:', message);
        app.handleChat(message);
    });

    // login / register responses from server (if you implement them)
    socket.on('loginResult', function(result) {
        console.log('[CLIENT] loginResult:', result);
        if (result.success) {
            app.loggedIn = true;
            app.username = result.username || app.username;
        } else {
            alert('Login failed: ' + result.message);
        }
    });

    socket.on('registerResult', function(result) {
        console.log('[CLIENT] registerResult:', result);
        if (result.success) {
            alert('Registration OK: ' + result.message);
        } else {
            alert('Registration failed: ' + result.message);
        }
    });
}
