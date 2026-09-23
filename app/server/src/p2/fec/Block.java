package p2.fec;

/**
 * How a message is cut up for sending, and the coefficients both ends agree on.
 *
 * A message (one image unit, usually 10-90 KB) is split into blocks of at most
 * {@link #MAX_SYMBOLS} source symbols of {@link #SYMBOL_BYTES} each. Each block is repaired
 * on its own, which keeps the cost of rebuilding one low: solving a block of k symbols costs
 * about k squared over two row operations, so many small blocks beat one huge one.
 *
 * Symbols of a block are numbered from 0. The first k are the source symbols themselves -
 * the coding is systematic, so when nothing is lost the receiver simply concatenates them and
 * never solves anything. Symbols numbered k and above are repair symbols: each is a mixture
 * of all k source symbols, with coefficients generated from the symbol's own number. Both
 * ends generate them the same way, so a repair symbol needs to carry only its number, not its
 * coefficients.
 */
public final class Block {

    /** Payload bytes per symbol, chosen to keep a packet under a typical 1500-byte path. */
    public static final int SYMBOL_BYTES = 1200;

    /** Source symbols per block. Bounded so rebuilding a block stays a few milliseconds. */
    public static final int MAX_SYMBOLS = 64;

    private Block() {}

    /** How many blocks a message of this length is cut into. */
    public static int blockCount(int messageLength) {
        int symbols = symbolCount(messageLength);
        return Math.max(1, (symbols + MAX_SYMBOLS - 1) / MAX_SYMBOLS);
    }

    /** How many source symbols the whole message needs. */
    public static int symbolCount(int messageLength) {
        return Math.max(1, (messageLength + SYMBOL_BYTES - 1) / SYMBOL_BYTES);
    }

    /** Source symbols in one block: the last block carries what is left over. */
    public static int symbolsIn(int messageLength, int block) {
        int total = symbolCount(messageLength);
        int start = block * MAX_SYMBOLS;
        return Math.max(0, Math.min(MAX_SYMBOLS, total - start));
    }

    /** Where a block's bytes start inside the message. */
    public static int offsetOf(int block) {
        return block * MAX_SYMBOLS * SYMBOL_BYTES;
    }

    /**
     * The coefficients of repair symbol {@code symbol} over a block of {@code k} source
     * symbols, derived from the symbol number alone so both ends agree without sending them.
     *
     * The generator is a small, fixed mixer (SplitMix64) rather than {@link java.util.Random},
     * because the sender and the receiver must produce identical bytes on any machine and any
     * language - the browser side has to reproduce these too. Coefficients are never zero:
     * a zero would drop a source symbol from the mixture and make the repair symbol weaker.
     */
    public static byte[] coefficients(int symbol, int k) {
        byte[] out = new byte[k];
        long state = mix(0x9E3779B97F4A7C15L ^ (symbol * 0x2545F4914F6CDD1DL));
        for (int i = 0; i < k; i++) {
            state = mix(state + 0x9E3779B97F4A7C15L);
            int value = (int) ((state >>> 24) & 0xff);
            out[i] = (byte) (value == 0 ? 1 : value);
        }
        return out;
    }

    private static long mix(long z) {
        z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
        z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
        return z ^ (z >>> 31);
    }
}
