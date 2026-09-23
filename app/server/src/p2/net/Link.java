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

    /**
     * Anything the transport itself knows that is worth showing: the rate it has settled on,
     * how long packets are waiting, what it is losing. The session merges this into the
     * statistics it sends the viewer, so the panel shows the same numbers whichever transport
     * is underneath - and shows nothing extra for the one that has nothing to tell.
     */
    default java.util.Map<String, Object> extra() {
        return java.util.Map.of();
    }

    /** Called by the transport when a complete message arrives from the client. */
    interface Inbound {
        void message(ByteBuffer message);

        void closed();

        /** The transport's queue has drained: there is room to send more. */
        default void drained() {}

        /**
         * A message handed to the transport will not arrive after all - the view changed, or
         * its deadline passed. Whatever was assumed about the client holding it is not true.
         */
        default void abandoned(ByteBuffer message) {}
    }
}
