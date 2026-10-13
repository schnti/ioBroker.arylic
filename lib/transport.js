'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

const PORT = 2018;

/**
 * Raw UART API over TCP: the LA50 forwards plain text on port 2018 to its
 * amplifier MCU and back. Messages are separated by `;`.
 *
 * Other Arylic devices (Up2Stream, LinkPlay platform) wrap the same commands as
 * `MCU+PAS+RAKOIT:{message}&` in their TCP API — that would be a second class
 * with the same events and methods.
 *
 * Events: `connect`, `message` (string, without `;`), `close`, `error`.
 */
class RawTcpTransport extends EventEmitter {
    /**
     * @param {string} host IP address or host name
     */
    constructor(host) {
        super();
        this.host = host;
        this.socket = null;
        this.buffer = '';
    }

    /** Opens the connection; progress is reported through the events. */
    connect() {
        this.buffer = '';
        const socket = net.createConnection({ host: this.host, port: PORT });
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('connect', () => this.emit('connect'));
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', err => this.emit('error', err));
        socket.on('close', () => this.emit('close'));
    }

    /**
     * Splits incoming text at `;`; an incomplete rest waits for the next chunk.
     *
     * @param {string} chunk text as received from the socket
     */
    receive(chunk) {
        this.buffer += chunk;
        const parts = this.buffer.split(';');
        this.buffer = parts.pop();
        for (const part of parts) {
            const message = part.trim();
            if (message) {
                this.emit('message', message);
            }
        }
    }

    /**
     * @param {string} text command without the trailing `;`
     * @returns {boolean} false if there is no open connection
     */
    send(text) {
        if (!this.socket || this.socket.destroyed) {
            return false;
        }
        this.socket.write(`${text};`);
        return true;
    }

    /** Closes the connection without emitting `close`. */
    destroy() {
        if (this.socket) {
            this.socket.removeAllListeners('close');
            this.socket.destroy();
            this.socket = null;
        }
    }
}

module.exports = { RawTcpTransport };
