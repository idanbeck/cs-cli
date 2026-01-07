// Network protocol message type definitions for CS-CLI multiplayer
// ============ Helpers ============
export function isClientMessage(msg) {
    return typeof msg === 'object' && msg !== null && 'type' in msg;
}
export function parseClientMessage(data) {
    try {
        const msg = JSON.parse(data);
        if (isClientMessage(msg)) {
            return msg;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function serializeServerMessage(msg) {
    return JSON.stringify(msg);
}
