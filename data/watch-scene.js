class WatchScene extends Scene {
    constructor() {
        super();
    }

    start() {
    }

    update() {
    }

    draw() {      
        background(this.color);
        fill(255);
        textSize(32);
        textAlign(CENTER, CENTER);
        text("Watch", width/2, height/2);
    }

    exit() {
    
    }

}