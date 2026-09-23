package p2.fec;

/**
 * Arithmetic in GF(256) - the field the repair symbols are built in.
 *
 * Every byte is treated as an element of a field with 256 members, where "add" is exclusive
 * or and "multiply" follows the same polynomial arithmetic Reed-Solomon codes use. What
 * matters here is that the rules of ordinary algebra hold: every non-zero element has an
 * inverse, so a system of linear equations in these bytes can be solved by elimination,
 * which is exactly how a unit is rebuilt from a mixture of its symbols.
 *
 * Multiplication is a table lookup rather than a computation: 64 KB of table, built once,
 * turns every multiply into one array access.
 */
public final class Galois {

    /** x^8 + x^4 + x^3 + x^2 + 1, the polynomial Reed-Solomon implementations use. */
    private static final int POLYNOMIAL = 0x11D;

    private static final byte[][] PRODUCT = new byte[256][256];
    private static final byte[] INVERSE = new byte[256];

    static {
        int[] exp = new int[512];
        int[] log = new int[256];
        int value = 1;
        for (int power = 0; power < 255; power++) {
            exp[power] = value;
            log[value] = power;
            value <<= 1;
            if ((value & 0x100) != 0) value ^= POLYNOMIAL;
        }
        for (int power = 255; power < 512; power++) exp[power] = exp[power - 255];

        for (int a = 1; a < 256; a++) {
            for (int b = 1; b < 256; b++) {
                PRODUCT[a][b] = (byte) exp[log[a] + log[b]];
            }
            INVERSE[a] = (byte) exp[255 - log[a]];
        }
    }

    private Galois() {}

    public static byte multiply(byte a, byte b) {
        return PRODUCT[a & 0xff][b & 0xff];
    }

    /** The element that multiplies {@code a} to 1. Undefined for zero, which has no inverse. */
    public static byte inverse(byte a) {
        return INVERSE[a & 0xff];
    }

    /** destination ^= source * factor, over a whole symbol. The inner loop of everything here. */
    public static void multiplyAdd(byte[] destination, byte[] source, byte factor) {
        if (factor == 0) return;
        byte[] row = PRODUCT[factor & 0xff];
        for (int i = 0; i < destination.length; i++) {
            destination[i] ^= row[source[i] & 0xff];
        }
    }

    /** destination *= factor, over a whole symbol. */
    public static void multiply(byte[] destination, byte factor) {
        byte[] row = PRODUCT[factor & 0xff];
        for (int i = 0; i < destination.length; i++) {
            destination[i] = row[destination[i] & 0xff];
        }
    }
}
