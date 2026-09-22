package p2.media;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

/**
 * How an image becomes something that can be sent - the first of the two swap points.
 *
 * A method has two halves. {@link #prepare} runs once per image, offline, and writes whatever
 * the method needs to serve it later (for ladder tiles: JPEG tiles on disk). {@link #open}
 * gives back a {@link Served} view of that preparation, which the session layer asks "what
 * units does this viewport need, most important first" and "give me the bytes of unit X".
 *
 * Everything above this interface - sessions, scheduling, the protocol - deals only in
 * opaque units, so a different method (splats, progressive JPEG, anything) can be dropped in
 * by implementing these two halves and a matching renderer in the browser.
 */
public interface ImageMethod {

    /** Stable id, stored with the preparation and sent to the client so it picks the renderer. */
    String id();

    /** One-time conversion of a source image. Must be safe to re-run over a half-finished run. */
    void prepare(Path source, Path preparedDir, Progress progress) throws IOException;

    /** Open a finished preparation for serving. */
    Served open(Path preparedDir) throws IOException;

    /** True if this directory holds a finished preparation of this method. */
    boolean isPrepared(Path preparedDir);

    /** A prepared image, ready to serve. Implementations must be safe for concurrent use. */
    interface Served {
        Meta meta();

        /** The units this viewport needs, most important first (nearest the centre). */
        List<UnitId> unitsFor(Viewport viewport);

        /** The bytes of one unit, exactly as they should reach the client. */
        byte[] bytes(UnitId id) throws IOException;

        /** How the client should interpret unit bytes, e.g. "image/jpeg". */
        String unitContentType();
    }

    /** Progress of a preparation, for the server site to display. */
    interface Progress {
        void step(String stage, long done, long total);
    }

    /**
     * What the client needs to know about a prepared image.
     *
     * @param width      source width in pixels
     * @param height     source height in pixels
     * @param unitSize   pixels per unit edge (tile size, for ladder tiles)
     * @param ratio      scale step between levels (1.25 = each level 1.25x smaller)
     * @param maxLevel   coarsest level; level L is ratio^L times smaller than the source
     * @param units      how many units the whole preparation holds
     * @param bytes      what the preparation occupies on disk
     */
    record Meta(int width, int height, int unitSize, double ratio, int maxLevel, int units, long bytes) {}

    /** One sendable piece of an image. Meaning of x and y is up to the method (tile column/row). */
    record UnitId(int level, int x, int y) {
        @Override public String toString() { return level + "/" + x + "_" + y; }
    }

    /**
     * What the viewer is looking at.
     *
     * @param cx      centre of the view, in source pixels
     * @param cy      centre of the view, in source pixels
     * @param scale   source pixels per screen pixel (2.0 = zoomed out by two)
     * @param screenW viewport width in screen pixels
     * @param screenH viewport height in screen pixels
     */
    record Viewport(double cx, double cy, double scale, int screenW, int screenH) {}
}
