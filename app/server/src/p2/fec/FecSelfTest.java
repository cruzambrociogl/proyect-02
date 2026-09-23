package p2.fec;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

/**
 * Checks the symbol codec on its own, before any of it is put on a wire.
 *
 *   java -cp server/build p2.fec.FecSelfTest
 *
 * Three questions, because each has bitten this kind of code before:
 *   - does the arithmetic obey the field's rules (every element invertible, distributive)?
 *   - with nothing lost, does a receiver rebuild the message without doing any algebra?
 *   - with symbols lost at random, does it still rebuild the message byte for byte, and how
 *     many symbols does it take?
 */
public final class FecSelfTest {

    private static int failures;

    public static void main(String[] args) {
        arithmetic();
        roundTrip();
        lossy();
        System.out.println(failures == 0 ? "\nall checks passed" : "\n" + failures + " CHECKS FAILED");
        if (failures > 0) System.exit(1);
    }

    private static void arithmetic() {
        System.out.println("field arithmetic");
        for (int a = 1; a < 256; a++) {
            check(Galois.multiply((byte) a, Galois.inverse((byte) a)) == 1,
                    "every non-zero element has an inverse (failed at " + a + ")");
        }
        Random random = new Random(1);
        for (int trial = 0; trial < 10_000; trial++) {
            byte a = (byte) random.nextInt(256), b = (byte) random.nextInt(256), c = (byte) random.nextInt(256);
            byte left = Galois.multiply(a, (byte) (b ^ c));
            byte right = (byte) (Galois.multiply(a, b) ^ Galois.multiply(a, c));
            check(left == right, "multiplication distributes over addition");
        }
        System.out.println("  ok");
    }

    private static void roundTrip() {
        System.out.println("no loss: the receiver should need no repair symbols");
        for (int length : new int[]{1, 999, Block.SYMBOL_BYTES, 60_000, 90_000, 250_000}) {
            byte[] message = random(length, 7);
            MessageCodec.Encoder encoder = new MessageCodec.Encoder(message);
            MessageCodec.Receiver receiver = new MessageCodec.Receiver(length);
            int sent = 0;
            for (int block = 0; block < encoder.blocks(); block++) {
                for (int i = 0; i < encoder.symbolsIn(block); i++) {
                    receiver.accept(block, i, encoder.symbol(block, i));
                    sent++;
                }
            }
            check(receiver.complete(), length + " bytes: complete after the source symbols");
            check(Arrays.equals(message, receiver.message()), length + " bytes: rebuilt exactly");
            System.out.printf("  %7d bytes  %d blocks  %d symbols%n", length, encoder.blocks(), sent);
        }
    }

    private static void lossy() {
        System.out.println("with loss: any k independent symbols should rebuild the message");
        int length = 60_000;                       // a typical image unit
        byte[] message = random(length, 11);
        System.out.printf("  %-6s %-8s %-9s %-10s %s%n", "loss", "sent", "overhead", "wasted", "decode");
        for (double loss : new double[]{0.0, 0.01, 0.05, 0.10, 0.20, 0.40}) {
            Random random = new Random(1234);
            MessageCodec.Encoder encoder = new MessageCodec.Encoder(message);
            MessageCodec.Receiver receiver = new MessageCodec.Receiver(length);

            List<int[]> plan = new ArrayList<>();   // (block, symbol) in sending order
            for (int block = 0; block < encoder.blocks(); block++) {
                int send = encoder.symbolsToSend(block, loss);
                for (int i = 0; i < send; i++) plan.add(new int[]{block, i});
            }

            int sent = 0, useless = 0;
            long started = System.nanoTime();
            int at = 0;
            while (!receiver.complete()) {
                int[] next;
                if (at < plan.size()) {
                    next = plan.get(at++);
                } else {
                    // the planned redundancy was not enough: ask for more, one block at a time
                    int[] missing = receiver.missing();
                    int block = 0;
                    while (block < missing.length && missing[block] == 0) block++;
                    next = new int[]{block, plan.size() + at++};
                }
                sent++;
                if (random.nextDouble() < loss) continue;               // lost in the network
                if (!receiver.accept(next[0], next[1], encoder.symbol(next[0], next[1]))) useless++;
            }
            double decodeMs = (System.nanoTime() - started) / 1e6;
            int sourceSymbols = Block.symbolCount(length);
            check(Arrays.equals(message, receiver.message()),
                    String.format("%.0f%% loss: rebuilt exactly", loss * 100));
            System.out.printf("  %-6s %-8d %-9s %-10d %.1f ms%n",
                    String.format("%.0f%%", loss * 100), sent,
                    String.format("%.0f%%", 100.0 * (sent - sourceSymbols) / sourceSymbols),
                    useless, decodeMs);
        }
    }

    private static byte[] random(int length, long seed) {
        byte[] out = new byte[length];
        new Random(seed).nextBytes(out);
        return out;
    }

    private static void check(boolean condition, String what) {
        if (!condition) {
            failures++;
            System.out.println("  FAILED: " + what);
        }
    }
}
