function createPopupElement() {
  let markup = "";
  const element = {};
  Object.defineProperty(element, "innerHTML", {
    configurable: true,
    get() { return markup; },
    set(value) { markup = String(value || ""); },
  });
  return element;
}

function createPhotoMapDocument() {
  return {
    createElement() {
      const content = createPopupElement();
      const child = createPopupElement();
      Object.defineProperty(content, "innerHTML", {
        configurable: true,
        get() { return child.innerHTML; },
        set(value) { child.innerHTML = value; },
      });
      content.firstElementChild = child;
      return content;
    },
  };
}

function popupText(content) {
  return content && typeof content.innerHTML === "string"
    ? content.innerHTML
    : String(content || "");
}

module.exports = {createPhotoMapDocument, popupText};
