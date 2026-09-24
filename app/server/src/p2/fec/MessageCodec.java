package p2.fec;

/**
 * A whole message (one image unit) as a stream of symbols, and the receiving half that puts
 * it back together.
 *
 * The sender walks {@link Encoder#symbol}: the first symbols of each block are the message's
 * own bytes, so a receiver that loses nothing does no arithmetic at all; repair symbols come
 * after, and can be generated for ever - there is no fixed limit, so the sender simply keeps
 * producing them until the receiver says it has enough.
 *
 * The receiver ({@link Receiver}) accepts symbols in any order and reports how many more it
 * needs. That count is the only feedback the protocol sends about losses: never which packets
 * went missing, only how many symbols are still wanted.
 */
public final class MessageCodec {

    private MessageCodec() {}

    /** Turns a message into as many symbols as anyone asks for. */
    public static final class Encoder {
        private final byte[] message;
        private final int blocks;

        public Encoder(byte[] message) {
            this.message = message;
            this.blocks = Block.blockCount(message.length);
        }

        public int blocks() { return blocks; }

        public int symbolsIn(int block) { return Block.symbolsIn(message.length, block); }

        /**
         * How many symbols to send for a block to survive the loss rate we expect.
         *
         * Enough to replace what the path is expected to swallow, and one spare on top - but
         * only where something is actually being lost. The spare buys one thing: it saves a
         * round trip when a single packet goes missing. On a path losing nothing it buys
         * nothing, and for the small blocks an image tile makes - a 12 KB tile is ten symbols
         * - one spare is a tenth of the transfer. So a clean path pays exactly the message,
         * and the margin appears when there is loss to cover.
         */
        public int symbolsToSend(int block, double lossRate) {
            int k = symbolsIn(block);
            if (lossRate <= 0.005) return k;
            int repair = (int) Math.ceil(k * lossRate / Math.max(0.05, 1 - lossRate));
            return k + repair + 1;
        }

        /**
         * Symbol number {@code index} of {@code block}: below k it is the block's own bytes,
         * at or above k it is a mixture of all of them.
         */
        public byte[] symbol(int block, int index) {
            int k = symbolsIn(block);
            byte[] out = new byte[Block.SYMBOL_BYTES];
            if (index < k) {
                copySource(block, index, out);
                return out;
            }
            byte[] coefficients = Block.coefficients(index, k);
            byte[] source = new byte[Block.SYMBOL_BYTES];
            for (int i = 0; i < k; i++) {
                copySource(block, i, source);
                Galois.multiplyAdd(out, source, coefficients[i]);
            }
            return out;
        }

        private void copySource(int block, int index, byte[] out) {
            java.util.Arrays.fill(out, (byte) 0);
            int from = Block.offsetOf(block) + index * Block.SYMBOL_BYTES;
            int length = Math.min(Block.SYMBOL_BYTES, message.length - from);
            if (length > 0) System.arraycopy(message, from, out, 0, length);
        }
    }

    /** Collects symbols of one message until every block can be solved. */
    public static final class Receiver {
        private final int messageLength;
        private final BlockDecoder[] decoders;

        public Receiver(int messageLength) {
            this.messageLength = messageLength;
            this.decoders = new BlockDecoder[Block.blockCount(messageLength)];
            for (int b = 0; b < decoders.length; b++) {
                decoders[b] = new BlockDecoder(Block.symbolsIn(messageLength, b), Block.SYMBOL_BYTES);
            }
        }

        public boolean accept(int block, int symbolIndex, byte[] data) {
            return decoders[block].accept(symbolIndex, data);
        }

        public boolean complete() {
            for (BlockDecoder decoder : decoders) {
                if (!decoder.complete()) return false;
            }
            return true;
        }

        /** Symbols still needed, per block - what the receiver asks the sender for. */
        public int[] missing() {
            int[] out = new int[decoders.length];
            for (int b = 0; b < decoders.length; b++) out[b] = decoders[b].missing();
            return out;
        }

        public int missingTotal() {
            int total = 0;
            for (BlockDecoder decoder : decoders) total += decoder.missing();
            return total;
        }

        /** The original message. Only valid once {@link #complete()}. */
        public byte[] message() {
            byte[] out = new byte[messageLength];
            for (int b = 0; b < decoders.length; b++) {
                byte[][] solved = decoders[b].solve();
                for (int i = 0; i < solved.length; i++) {
                    int to = Block.offsetOf(b) + i * Block.SYMBOL_BYTES;
                    int length = Math.min(Block.SYMBOL_BYTES, messageLength - to);
                    if (length > 0) System.arraycopy(solved[i], 0, out, to, length);
                }
            }
            return out;
        }
    }
}
