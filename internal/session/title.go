package session

import "strings"

// maxTitleLen bounds an in-progress OSC payload so a malformed stream
// cannot grow the scanner without limit.
const maxTitleLen = 1024

type titleState int

const (
	stGround titleState = iota
	stEsc               // saw ESC
	stOSC               // saw ESC ], reading the numeric parameter
	stTitle             // reading the title payload
	stTitleEsc          // inside the payload, saw ESC (candidate ST)
	stIgnore            // inside an OSC we do not care about
	stIgnoreEsc
)

// TitleScanner extracts window titles from OSC 0 and OSC 2 sequences in a
// byte stream. It tolerates arbitrary chunk boundaries.
type TitleScanner struct {
	state titleState
	param []byte
	buf   strings.Builder
}

func NewTitleScanner() *TitleScanner { return &TitleScanner{} }

// Feed consumes p and reports the last complete title it contained.
func (s *TitleScanner) Feed(p []byte) (string, bool) {
	var last string
	var found bool

	for _, c := range p {
		switch s.state {
		case stGround:
			if c == 0x1b {
				s.state = stEsc
			}

		case stEsc:
			if c == ']' {
				s.state = stOSC
				s.param = s.param[:0]
			} else if c == 0x1b {
				// stay in stEsc
			} else {
				s.state = stGround
			}

		case stOSC:
			switch {
			case c == ';':
				p := string(s.param)
				if p == "0" || p == "2" {
					s.state = stTitle
					s.buf.Reset()
				} else {
					s.state = stIgnore
				}
			case c >= '0' && c <= '9':
				if len(s.param) < 8 {
					s.param = append(s.param, c)
				} else {
					s.state = stIgnore
				}
			default:
				s.state = stGround
			}

		case stTitle:
			switch {
			case c == 0x07: // BEL terminator
				last, found = s.buf.String(), true
				s.buf.Reset()
				s.state = stGround
			case c == 0x1b:
				s.state = stTitleEsc
			case s.buf.Len() >= maxTitleLen:
				s.buf.Reset()
				s.state = stGround
			default:
				s.buf.WriteByte(c)
			}

		case stTitleEsc:
			if c == '\\' { // ST terminator
				last, found = s.buf.String(), true
				s.buf.Reset()
				s.state = stGround
			} else {
				// Not a terminator: abandon this sequence rather than
				// silently absorbing an escape we do not model.
				s.buf.Reset()
				s.state = stGround
			}

		case stIgnore:
			switch c {
			case 0x07:
				s.state = stGround
			case 0x1b:
				s.state = stIgnoreEsc
			}

		case stIgnoreEsc:
			if c == '\\' {
				s.state = stGround
			} else {
				s.state = stIgnore
			}
		}
	}

	return last, found
}
