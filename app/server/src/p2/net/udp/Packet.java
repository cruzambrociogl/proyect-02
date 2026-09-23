package p2.net.udp;

import java.nio.ByteBuffer;

/**
 * What one datagram looks like.
 *
 * Every packet starts with the same 16 bytes:
 *
 *   0   'P'          magic, so anything that is not ours is dropped without further thought
 *   1   '2'
 *   2   version
 *   3   type         the constants below, continuing {@link p2.net.Wire}'s numbering
 *   4   session      chosen by the server at the handshake; identifies the viewer
 *   8   sequence     counts every packet this side has sent, in order, never repeated
 *   12  micros       the sender's clock when it left, in microseconds
 *
 * The sequence number is not there to order or to reassemble anything - the symbol codec does
 * not care what arrives or in what order. It is there to measure: a receiver that has seen 940
 * packets out of a highest sequence of 1000 knows the path is losing 6% without either side
 * tracking which packets those were. The clock is there for the same reason, for delay.
 *
 * A packet is never split. Everything here fits in one datagram of about 1250 bytes, well
 * inside the smallest path anyone is likely to have, so there is no IP fragmentation to lose.
 */
public final class Packet {

    public static final byte MAGIC_0 = 'P', MAGIC_1 = '2';
    public static final int VERSION = 1;
    public static final int HEADER = 16;

    /** server -> client: one symbol of one unit. The only packet that carries image bytes. */
    public static final int DATA = 10;
    /** client -> server: what I have received, how long I held it, and what I still need. */
    public static final int REPORT = 11;

    /** Biggest datagram this protocol ever sends: header, symbol header, one symbol. */
    public static final int MAX_DATAGRAM = HEADER + DataHeader.BYTES + p2.fec.Block.SYMBOL_BYTES;

    private Packet() {}

    public static ByteBuffer allocate() {
        return ByteBuffer.allocate(MAX_DATAGRAM);
    }

    /** Writes the common header and leaves the buffer ready for the payload. */
    public static ByteBuffer header(ByteBuffer out, int type, int session, int sequence, int micros) {
        out.clear();
        out.put(MAGIC_0).put(MAGIC_1).put((byte) VERSION).put((byte) type);
        out.putInt(session);
        out.putInt(sequence);
        out.putInt(micros);
        return out;
    }

    public static boolean looksValid(ByteBuffer b) {
        return b.remaining() >= HEADER
                && b.get(b.position()) == MAGIC_0
                && b.get(b.position() + 1) == MAGIC_1
                && b.get(b.position() + 2) == VERSION;
    }

    public static int type(ByteBuffer b) { return b.get(b.position() + 3) & 0xff; }

    public static int session(ByteBuffer b) { return b.getInt(b.position() + 4); }

    public static int sequence(ByteBuffer b) { return b.getInt(b.position() + 8); }

    public static int micros(ByteBuffer b) { return b.getInt(b.position() + 12); }

    /** The sender's clock, in microseconds. Wraps every 71 minutes; only differences are used. */
    public static int now() {
        return (int) (System.nanoTime() / 1000L);
    }

    /**
     * What rides in front of a symbol.
     *
     * The unit number and the total length let a receiver set up for a unit from whichever of
     * its symbols happens to arrive first - there is no "start of unit" packet to lose. The
     * epoch is repeated here, outside the encoded bytes, so a receiver can throw away symbols
     * of a view the viewer has already left without having to decode them first.
     */
    public record DataHeader(int epoch, int unit, int length, int block, int symbol) {

        public static final int BYTES = 16;

        public void writeTo(ByteBuffer out) {
            out.putInt(epoch);
            out.putInt(unit);
            out.putInt(length);
            out.putShort((short) block);
            out.putShort((short) symbol);
        }

        public static DataHeader readFrom(ByteBuffer in) {
            return new DataHeader(in.getInt(), in.getInt(), in.getInt(),
                    in.getShort() & 0xffff, in.getShort() & 0xffff);
        }
    }
}
