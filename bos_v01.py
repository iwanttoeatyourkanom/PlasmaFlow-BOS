import cv2          # OpenCV: read images, process them, colormaps, save
import numpy as np  # OpenCV images ARE NumPy arrays; we keep it imported for clarity


# ----- 1. choose the two input files --------------------------------------
# reference = background pattern with NO flame (undisturbed)
# test      = background pattern WITH flame (pattern looks slightly shifted)
REF_PATH  = "reference.png"
TEST_PATH = "test.png"


# ----- 2. load the images -------------------------------------------------
ref  = cv2.imread(REF_PATH)
test = cv2.imread(TEST_PATH)

# safety check: imread returns None if the file name/path is wrong
if ref is None or test is None:
    raise SystemExit("Cannot open the images. Check that the file names are correct.")

# the difference compares pixel-by-pixel, so both images must be the same size.
# if not, resize the test image to match the reference.
if ref.shape != test.shape:
    test = cv2.resize(test, (ref.shape[1], ref.shape[0]))


# ----- 3. convert to grayscale --------------------------------------------
# BOS works on brightness changes, so color is not needed. Drop to 1 channel.
ref_gray  = cv2.cvtColor(ref,  cv2.COLOR_BGR2GRAY)
test_gray = cv2.cvtColor(test, cv2.COLOR_BGR2GRAY)


# ----- 4. calculate the image difference ----------------------------------
# Where the flame bends light, the background pattern appears to move, so the
# two frames disagree there. absdiff gives |test - ref| at every pixel.
diff = cv2.absdiff(ref_gray, test_gray)


# ----- 5. stretch the contrast so faint differences become visible --------
# Real differences are usually small (a few brightness levels). normalize maps
# the darkest value to 0 and the brightest to 255, making the flame readable.
diff_vis = cv2.normalize(diff, None, 0, 255, cv2.NORM_MINMAX)


# ----- 6. make the pseudo-color version -----------------------------------
# A colormap turns gray levels into colors (blue = small change ... red = large)
# so the eye can read the flame structure much more easily.
diff_color = cv2.applyColorMap(diff_vis, cv2.COLORMAP_JET)


# ----- 7. show the results on screen -----
MAX_H = 900  # ปรับตามความสูงจอของคุณ

h, w = diff_vis.shape[:2]
scale = min(1.0, MAX_H / h)
dsize = (int(w * scale), int(h * scale))

left  = cv2.resize(cv2.cvtColor(diff_vis, cv2.COLOR_GRAY2BGR), dsize)
right = cv2.resize(diff_color, dsize)

combined = np.hstack([left, right])
cv2.imshow("BOS Result  |  Grayscale  vs  Pseudo-color", combined)
cv2.waitKey(0)
cv2.destroyAllWindows()


# ----- 8. save the result images ------------------------------------------
cv2.imwrite("diff_grayscale.png", diff_vis)
cv2.imwrite("diff_color.png", diff_color)
print("Done. Saved: diff_grayscale.png and diff_color.png")
