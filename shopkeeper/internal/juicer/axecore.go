package juicer

import (
	_ "embed"
)

// axeMinJS contains the minified axe-core library.
// It is embedded at compile time from the axe.min.js file.
//
//go:embed axe.min.js
var axeMinJS string
