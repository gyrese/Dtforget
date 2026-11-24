// getRandomValues also works when the game is served over HTTP on the local network.
function gameToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

const GAME_ACK_MS = 4500;

function reconnectWhenOnline(socket) {
  window.addEventListener("online", () => {
    // After a network change the old connection can look open until the next heartbeat.
    if (socket.connected) socket.io.engine.close();
    else socket.connect();
  });
}

function gameSocket() {
  return io({ autoConnect: false, tryAllTransports: true });
}
