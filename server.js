const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Load auction data
const auctionData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/players.json')));

// Store multiple game sessions
let activeSessions = [];

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// WebSocket connection logic
wss.on('connection', (ws) => {
    let session = getOrCreateSession();
    let playerId = session.players.length + 1;

    session.players.push({ id: playerId, team: null, budget: 1000 });
    session.clients.push(ws);
    console.log(`Player ${playerId} connected to Session ${session.id}.`);

    // Send initial team data
    ws.send(JSON.stringify({ type: 'teamDetails', teamBudgets: getTeamBudgets(session), purchasedPlayers: session.purchasedPlayers }));

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
            return;
        }

        if (data.type === 'select-team') {
            handleTeamSelection(session, ws, playerId, data.team);
        } else if (data.type === 'placeBid') {
            handleBid(session, ws, playerId, data.bidAmount);
        } else if (data.type === 'timerEnded') {
            handleTimerEnd(session);
        }
    });

    ws.on('close', () => {
        session.clients = session.clients.filter((client) => client !== ws);
        console.log(`Player ${playerId} disconnected from Session ${session.id}.`);
    });
});

// Get an existing session or create a new one
function getOrCreateSession() {
    let openSession = activeSessions.find((s) => s.players.length < 3);
    if (openSession) return openSession;

    let newSession = {
        id: activeSessions.length + 1,
        players: [],
        clients: [],
        currentCategoryIndex: 0,
        currentPlayerIndex: 0,
        highestBid: null,
        auctionTimer: null,
        purchasedPlayers: { MI: [], RCB: [], CSK: [] },
    };
    activeSessions.push(newSession);
    return newSession;
}

// Broadcast a message to all clients in a session
function broadcast(session, message) {
    session.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Handle team selection logic
function handleTeamSelection(session, ws, playerId, team) {
    if (isTeamTaken(session, team)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Team already taken. Choose another team.' }));
    } else {
        let player = session.players.find((p) => p.id === playerId);
        player.team = team;

        ws.send(JSON.stringify({ type: 'teamSelected', message: `Team ${team} selected.` }));

        const selectedTeams = session.players.filter(p => p.team).length;
        broadcast(session, { type: 'waitingForPlayers', remaining: 3 - selectedTeams });

        if (selectedTeams === 3) {
            setTimeout(() => startAuction(session), 2000); // Delay before auction starts
        }
    }
}

// Check if a team is already taken in a session
function isTeamTaken(session, team) {
    return session.players.some((player) => player.team === team);
}

// Start the auction process for a session
function startAuction(session) {
    console.log(`Session ${session.id}: Starting auction...`);
    broadcast(session, { type: 'startAuction', auctionData: getCurrentPlayerData(session) });
    startTimer(session);
}

// Handle bid logic for a session
function handleBid(session, ws, playerId, bidAmount) {
    const player = session.players.find((p) => p.id === playerId);
    if (!player) return;
    if (isNaN(bidAmount) || bidAmount <= 0 || bidAmount <= (session.highestBid?.amount || 0) || bidAmount > player.budget) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid bid.' }));
        return;
    }

    session.highestBid = { amount: bidAmount, team: player.team };
    broadcast(session, { type: 'newHighestBid', bidAmount, team: player.team });
}

// Get current player's data for a session
function getCurrentPlayerData(session) {
    const category = auctionData.categories[session.currentCategoryIndex];
    return { 
        ...category.players[session.currentPlayerIndex], 
        category: category.category // FIXED CATEGORY NAME ISSUE
    };
}

// Start the auction timer for a session
function startTimer(session) {
    let timeLeft = 20;
    session.auctionTimer = setInterval(() => {
        timeLeft--;
        broadcast(session, { type: 'timerUpdate', timeLeft });
        if (timeLeft === 0) {
            clearInterval(session.auctionTimer);
            handleTimerEnd(session);
        }
    }, 1000);
}

// Handle the end of the timer for a session
function handleTimerEnd(session) {
    if (session.highestBid) {
        finalizeAuction(session);
    } else {
        broadcast(session, { type: 'playerUnsold', player: getCurrentPlayerData(session) });
        moveToNextPlayer(session);
    }
}

// Finalize the auction for the current player in a session
function finalizeAuction(session) {
    const playerData = getCurrentPlayerData(session);
    session.purchasedPlayers[session.highestBid.team].push({ name: playerData.name, price: session.highestBid.amount });

    broadcast(session, {
        type: 'playerSold',
        player: playerData,
        team: session.highestBid.team,
        bidAmount: session.highestBid.amount,
        purchasedPlayers: session.purchasedPlayers,
    });

    const winningPlayer = session.players.find((p) => p.team === session.highestBid.team);
    if (winningPlayer) {
        winningPlayer.budget -= session.highestBid.amount;
    }

    session.highestBid = null;
    moveToNextPlayer(session);
}

// Move to the next player or category in a session
function moveToNextPlayer(session) {
    session.currentPlayerIndex++;
    if (session.currentPlayerIndex >= auctionData.categories[session.currentCategoryIndex].players.length) {
        session.currentPlayerIndex = 0;
        session.currentCategoryIndex++;
    }
    if (session.currentCategoryIndex >= auctionData.categories.length) {
        broadcast(session, { type: 'auctionComplete' });
        console.log(`Session ${session.id}: Auction complete.`);
        resetAuction(session);
        return;
    }
    broadcast(session, { type: 'newAuctionPlayer', player: getCurrentPlayerData(session) });
    startTimer(session);
}

// Get team budgets for a session
function getTeamBudgets(session) {
    return session.players.reduce((acc, player) => {
        acc[player.team] = player.budget;
        return acc;
    }, {});
}

// Reset the auction state for a session
function resetAuction(session) {
    session.players = [];
    session.clients = [];
    session.currentCategoryIndex = 0;
    session.currentPlayerIndex = 0;
    session.highestBid = null;
    session.purchasedPlayers = { MI: [], RCB: [], CSK: [] };
}

// Start the server
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
