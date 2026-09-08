/**
 * Cheerful confirmation lines. Deliberately a mix of Korean and English —
 * the kids read whichever one they know.
 */
export const CHECK_IN_MESSAGES = [
  { big: 'Here we go!', small: '오늘도 반가워요' },
  { big: "You're all set!", small: '이름표 나오는 중이에요' },
  { big: '준비 완료!', small: 'Have a great day' },
  { big: 'Awesome!', small: '잘 왔어요' },
  { big: 'Boom! 체크인 완료', small: 'Grab your name tag' },
  { big: '어서 와요!', small: 'Your label is printing' },
  { big: "Let's go!", small: '즐거운 시간 보내요' },
  { big: 'High five! 🖐️', small: '이름표 챙겨가세요' },
  { big: '반짝반짝 ⭐', small: 'You shine today' },
  { big: 'All checked in!', small: '예배 시간에 만나요' },
  { big: 'Woohoo! 🎉', small: '좋은 하루 보내요' },
  { big: 'Nice to see you!', small: '오늘 함께해요' },
]

export function randomCheckInMessage() {
  return CHECK_IN_MESSAGES[Math.floor(Math.random() * CHECK_IN_MESSAGES.length)]
}
