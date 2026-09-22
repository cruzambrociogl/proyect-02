package p2.net;

import java.nio.ByteBuffer;

/**
 * One connection to one viewer - the second swap point.
 *
 * The session above never learns how bytes actually travel. Today there are two
 * implementations: a WebSocket bridge (TCP, reliable, for the browser) and, from milestone 3,
 * our own protocol over UDP with its retransmission and congestion control. Both must answer
 * the same three questions: can I send more, take this message, and are we finished.
 */
public interface Link {

    /** Queue one complete protocol message. Returns false if the link would not take it. */
    boolean send(byte[] message);

    /**
     * Whether the session should keep handing over messages. A link says no once it has
     * enough queued to keep the wire busy; keeping this small is what makes cancelling a
     * stale view effective, because little has been committed by the time the view changes.
     */
    boolean writable();

    /** Bytes handed to the transport so far, for the viewer's panel and the bench. */
    long bytesSent();

    /** Messages handed to the transport so far. */
    long messagesSent();

    void close();

    /** Called by the transport when a complete message arrives from the client. */
    interface Inbound {
        void message(ByteBuffer message);

        void closed();

        /** The transport's queue has drained: there is room to send more. */
        default void drained() {}
    }
}
