package p2.fec;

import java.util.Arrays;

/**
 * Rebuilds one block from whatever symbols arrive, whichever they are.
 *
 * Every symbol - source or repair - is one linear equation in the block's k unknown source
 * symbols. Symbols are eliminated against the equations already held as they arrive, so the
 * work is spread over the transfer rather than done in one lump at the end, and a symbol that
 * adds nothing new (a duplicate, or a mixture that is a combination of ones already held) is
 * recognised and dropped immediately.
 *
 * Once k independent equations are in, the block is solved. Nothing anywhere needs to know
 * which symbols were lost: any k independent ones will do.
 */
public final class BlockDecoder {

    private final int symbols;              // k, the unknowns
    private final int symbolBytes;
    private final byte[][] equation;        // coefficients, in row echelon form by pivot
    private final byte[][] payload;         // the matching right-hand sides
    private int known;

    public BlockDecoder(int symbols, int symbolBytes) {
        this.symbols = symbols;
        this.symbolBytes = symbolBytes;
        this.equation = new byte[symbols][];
        this.payload = new byte[symbols][];
    }

    public int symbols() { return symbols; }

    public boolean complete() { return known == symbols; }

    /** How many more independent symbols this block still needs. */
    public int missing() { return symbols - known; }

    /**
     * Take one symbol. Returns true if it taught us something new; false if it was a
     * duplicate or otherwise dependent on what we already have.
     */
    public boolean accept(int symbolIndex, byte[] data) {
        if (complete()) return false;
        byte[] coefficients;
        if (symbolIndex < symbols) {
            coefficients = new byte[symbols];        // a source symbol: it *is* that unknown
            coefficients[symbolIndex] = 1;
        } else {
            coefficients = Block.coefficients(symbolIndex, symbols);
        }
        byte[] value = Arrays.copyOf(data, symbolBytes);

        for (int pivot = 0; pivot < symbols; pivot++) {
            if (coefficients[pivot] == 0) continue;
            if (equation[pivot] == null) {
                // a new pivot: normalise so its leading coefficient is one, and keep it
                byte factor = Galois.inverse(coefficients[pivot]);
                scale(coefficients, factor);
                Galois.multiply(value, factor);
                equation[pivot] = coefficients;
                payload[pivot] = value;
                known++;
                return true;
            }
            byte factor = coefficients[pivot];
            addScaled(coefficients, equation[pivot], factor);
            Galois.multiplyAdd(value, payload[pivot], factor);
        }
        return false;                                 // nothing left: it added no information
    }

    /**
     * The block's source symbols, in order. Only valid once {@link #complete()}.
     *
     * The rows are in echelon form, each with a leading one but entries still standing to the
     * right of it, so this walks back from the last pivot clearing those out - ordinary back
     * substitution.
     */
    public byte[][] solve() {
        if (!complete()) throw new IllegalStateException("block is still missing " + missing() + " symbols");
        for (int pivot = symbols - 1; pivot >= 0; pivot--) {
            for (int row = 0; row < pivot; row++) {
                byte factor = equation[row][pivot];
                if (factor == 0) continue;
                addScaled(equation[row], equation[pivot], factor);
                Galois.multiplyAdd(payload[row], payload[pivot], factor);
            }
        }
        return payload;
    }

    private static void scale(byte[] row, byte factor) {
        for (int i = 0; i < row.length; i++) row[i] = Galois.multiply(row[i], factor);
    }

    private static void addScaled(byte[] row, byte[] other, byte factor) {
        for (int i = 0; i < row.length; i++) row[i] ^= Galois.multiply(other[i], factor);
    }
}
