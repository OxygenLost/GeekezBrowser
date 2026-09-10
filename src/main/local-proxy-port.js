const net = require('net');
const dgram = require('dgram');

const LOOPBACK_HOST = '127.0.0.1';

function closeTcpServer(server) {
    return new Promise((resolve) => {
        if (!server) return resolve();
        try {
            server.close(() => resolve());
        } catch (e) {
            resolve();
        }
    });
}

function closeUdpSocket(socket) {
    return new Promise((resolve) => {
        if (!socket) return resolve();
        try {
            socket.close(() => resolve());
        } catch (e) {
            resolve();
        }
    });
}

function listenTcp(server, host, port = 0) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port, exclusive: true });
    });
}

function bindUdp(socket, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            socket.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            socket.removeListener('error', onError);
            resolve();
        };
        socket.once('error', onError);
        socket.once('listening', onListening);
        socket.bind({ address: host, port, exclusive: true });
    });
}

async function allocateLocalProxyPort(options = {}) {
    const host = options.host || LOOPBACK_HOST;
    const maxAttempts = Number.isInteger(options.maxAttempts) ? options.maxAttempts : 20;
    let lastError = null;

    // Windows can keep a just-closed UDP endpoint in a transient state. Try a
    // larger pool of OS-assigned ports and avoid reserving TCP and UDP sockets
    // on separate ephemeral ports.
    const attempts = process.platform === 'win32' ? Math.max(maxAttempts, 60) : maxAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const tcpServer = net.createServer();
        let udpSocket = null;
        try {
            const port = await listenTcp(tcpServer, host);
            // Reuse is needed by the Windows socket layer when a previous Xray
            // process has just released the same ephemeral endpoint.
            udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            await bindUdp(udpSocket, host, port);

            await closeUdpSocket(udpSocket);
            await closeTcpServer(tcpServer);
            return port;
        } catch (error) {
            lastError = error;
            await closeUdpSocket(udpSocket);
            await closeTcpServer(tcpServer);
        }
    }

    // Some Windows builds allocate a UDP endpoint first and reject a later
    // TCP bind on the same ephemeral port. Try the reverse reservation order
    // before reporting that the local proxy port is unavailable.
    for (let attempt = 0; attempt < attempts; attempt++) {
        const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let tcpServer = null;
        try {
            await bindUdp(udpSocket, host, 0);
            const port = udpSocket.address().port;
            tcpServer = net.createServer();
            await listenTcp(tcpServer, host, port);
            await closeTcpServer(tcpServer);
            await closeUdpSocket(udpSocket);
            return port;
        } catch (error) {
            lastError = error;
            await closeTcpServer(tcpServer);
            await closeUdpSocket(udpSocket);
        }
    }

    const error = new Error(`Unable to allocate a local TCP/UDP proxy port after ${attempts} attempts`);
    error.code = 'LOCAL_PROXY_PORT_UNAVAILABLE';
    error.cause = lastError;
    throw error;
}

function isXrayLocalBindFailure(logText, port) {
    const text = String(logText || '');
    if (!text) return false;

    const bindFailure = /failed to start[\s\S]*?listen\s+(?:tcp|udp)[\s\S]*?(?:bind:|address already in use|access permissions|forbidden by its access permissions|WSAEACCES)/i;
    if (!bindFailure.test(text)) return false;
    if (!Number.isInteger(Number(port))) return true;

    return new RegExp(`(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${Number(port)}\\b`, 'i').test(text);
}

module.exports = {
    allocateLocalProxyPort,
    isXrayLocalBindFailure
};
